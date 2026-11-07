import {
  type ArtifactStore,
  AuthorizationRefusedError,
  NO_PRIVACY_CEILING,
  type RuntimeAuthorizationDenial,
} from "@clockgrove/application";
import type {
  BrowserScope,
  ContextInspection,
  ContextInspectRequest,
  DocumentChangeRequest,
  DocumentReadRequest,
  DocumentVersionView,
  PrincipalId,
  PrivacyCategory,
} from "@clockgrove/contracts";
import type { TrustedExecutionContext } from "@clockgrove/contracts/trusted";
import {
  type DocumentChangeOutcome,
  type InspectorAccess,
  PostgreSqlActorDocuments,
  type PostgreSqlClient,
  PostgreSqlContextManifests,
  PostgreSqlConversationStore,
  PostgreSqlInspectorAudit,
  withClientTransaction,
} from "@clockgrove/persistence";
import { INSPECT_GRANT } from "./inspector.js";
import { assertWorldCommandContext, worldAuthorization } from "./world-commands.js";

/** The context and actor-document routes (`docs/protocols/context-assembly.md`). */
export const COGNITION_ROUTES = [
  "/v1/runtime/context/inspect",
  "/v1/runtime/actor-documents/change",
  "/v1/runtime/actor-documents/read",
] as const;

/**
 * Operator change sets over an actor's documents need their own grant: no other grant implies it,
 * and `runtime:world-inspect` stays read-only (issue 17).
 */
export const GOVERN_GRANT = "runtime:actor-govern";

/** No manifest of the scope matches the entry: an unknown and another world's are alike. */
export class ManifestNotFoundError extends Error {
  constructor() {
    super("manifest not found");
    this.name = "ManifestNotFoundError";
  }
}

/** No document version of the scope matches. */
export class DocumentNotFoundError extends Error {
  constructor() {
    super("document not found");
    this.name = "DocumentNotFoundError";
  }
}

type Subject = "context-manifest" | "actor-documents";

/**
 * Context manifests and governed documents for inspectors and operators. Each read or change is
 * admitted under the inspector rate limit and audited, allowed or refused (`inspector_accesses`).
 */
export class PostgreSqlCognitionInspector {
  private readonly audit: PostgreSqlInspectorAudit;
  private readonly documents: PostgreSqlActorDocuments;
  private readonly manifests: PostgreSqlContextManifests;
  private readonly conversations: PostgreSqlConversationStore;
  constructor(
    private readonly client: PostgreSqlClient,
    artifacts: ArtifactStore,
  ) {
    this.audit = new PostgreSqlInspectorAudit(client);
    this.documents = new PostgreSqlActorDocuments(client);
    this.manifests = new PostgreSqlContextManifests(client);
    this.conversations = new PostgreSqlConversationStore(client, artifacts);
  }

  /**
   * A turn's manifest under `runtime:world-inspect` and `operator_evidence`. A session participant
   * whose ceiling holds `conversation` also gets the context assembled again from the recorded
   * inputs; anyone else gets `reassembledHash: null`.
   */
  inspectContext(
    input: ContextInspectRequest,
    context: TrustedExecutionContext,
  ): Promise<ContextInspection> {
    return this.read(
      input,
      context,
      "context-manifest",
      INSPECT_GRANT,
      "operator_evidence",
      async (authorization) => {
        const found = await withClientTransaction(this.client, { authorization }, () =>
          this.manifests.find(input.scope, input.entry),
        );
        if (found === undefined) throw new ManifestNotFoundError();
        const readable =
          found.participant &&
          authorization.privacyCeiling.allowedCategories.includes("conversation");
        return {
          manifest: found.manifest,
          reassembledHash: readable
            ? await this.conversations.reassemble(authorization, input.scope, found.manifest)
            : null,
        };
      },
    );
  }

  /** One document version with its provenance, under `runtime:world-inspect` and `private_cognition`. */
  readDocument(
    input: DocumentReadRequest,
    context: TrustedExecutionContext,
  ): Promise<DocumentVersionView> {
    return this.read(
      input,
      context,
      "actor-documents",
      INSPECT_GRANT,
      "private_cognition",
      async (authorization) => {
        const found = await this.documents.read(
          authorization,
          input.scope,
          input.actorId,
          input.path,
          input.version,
        );
        if (found === undefined) throw new DocumentNotFoundError();
        return found;
      },
    );
  }

  /** An operator change set under `runtime:actor-govern` and `private_cognition`. */
  changeDocuments(
    input: DocumentChangeRequest,
    context: TrustedExecutionContext,
  ): Promise<DocumentChangeOutcome> {
    return this.read(
      input,
      context,
      "actor-documents",
      GOVERN_GRANT,
      "private_cognition",
      (authorization) =>
        this.documents.change(authorization, {
          tenantId: input.scope.tenantId,
          worldId: input.scope.worldId,
          timelineId: input.scope.timelineId,
          actorId: input.actorId,
          changeSetId: input.changeSetId,
          principalId: context.principalId,
          personaId: context.personaId ?? null,
          proposer: { kind: "operator" },
          operations: input.operations,
        }),
    );
  }

  /** Records a refused access under the requested tenant, whether or not the principal is a member. */
  deny(
    input: { readonly scope: BrowserScope },
    subject: Subject,
    principalId: PrincipalId,
    denial: RuntimeAuthorizationDenial | undefined,
  ): Promise<void> {
    return this.audit.record(
      { tenantId: input.scope.tenantId, principalId, privacyCeiling: NO_PRIVACY_CEILING },
      access(input.scope, subject, "deny", denial?.reasonCode ?? "authority-mismatch"),
    );
  }

  private async read<T>(
    input: { readonly scope: BrowserScope },
    context: TrustedExecutionContext,
    subject: Subject,
    grant: string,
    category: PrivacyCategory,
    run: (authorization: ReturnType<typeof worldAuthorization>) => Promise<T>,
  ): Promise<T> {
    try {
      assertWorldCommandContext(context, input.scope, grant);
      if (!context.privacyCeiling.allowedCategories.includes(category))
        throw new AuthorizationRefusedError(`${subject} ceiling refused`);
    } catch (error) {
      await this.deny(input, subject, context.principalId, undefined);
      throw error;
    }
    const authorization = worldAuthorization(context);
    await this.audit.admit(authorization);
    let reasonCode: InspectorAccess["reasonCode"] = "failed";
    try {
      const output = await run(authorization);
      reasonCode = "served";
      return output;
    } catch (error) {
      if (error instanceof ManifestNotFoundError || error instanceof DocumentNotFoundError)
        reasonCode = "not-found";
      throw error;
    } finally {
      await this.audit.record(authorization, access(input.scope, subject, "allow", reasonCode));
    }
  }
}

function access(
  scope: BrowserScope,
  subject: Subject,
  decision: InspectorAccess["decision"],
  reasonCode: InspectorAccess["reasonCode"],
): InspectorAccess {
  const { worldId, timelineId, spaceId } = scope;
  return { subject, worldId, timelineId, spaceId, decision, reasonCode };
}

export type CognitionChangeOutcome = DocumentChangeOutcome;
