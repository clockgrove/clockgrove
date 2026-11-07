import type { ModelBudgetPort, ModelBudgetReservation } from "./port.js";

/**
 * In-memory spend ledger: one limit per scope, in microdollars. Reservations hold spend until
 * settled with the actual cost. A durable, tenant-wide ledger is Wave 12 metering.
 */
export class InMemoryModelBudget implements ModelBudgetPort {
  private readonly spent = new Map<string, number>();
  constructor(private readonly limitMicrousd: (scope: string) => number) {}

  reserve(scope: string, microusd: number): ModelBudgetReservation | undefined {
    const used = this.spent.get(scope) ?? 0;
    if (used + microusd > this.limitMicrousd(scope)) return undefined;
    this.spent.set(scope, used + microusd);
    return { scope, microusd };
  }

  settle(reservation: ModelBudgetReservation, actualMicrousd: number): void {
    const used = this.spent.get(reservation.scope) ?? 0;
    this.spent.set(reservation.scope, used - reservation.microusd + actualMicrousd);
  }

  spentMicrousd(scope: string): number {
    return this.spent.get(scope) ?? 0;
  }
}
