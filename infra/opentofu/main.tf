variable "preserve_bindings" {
  type    = bool
  default = false
}
variable "preserve_public_activation" {
  type    = bool
  default = false
}
variable "activation_stage" {
  type    = string
  default = "provision"
  validation {
    condition     = contains(["provision", "bindings", "routing"], var.activation_stage)
    error_message = "Use provision, bindings or routing activation stage."
  }
}
variable "environment" {
  type    = string
  default = "local"
  validation {
    condition     = contains(["local", "ci", "development", "staging", "production"], var.environment)
    error_message = "Use a canonical environment."
  }
}
locals {
  config = jsondecode(file("${path.module}/../environments/${var.environment}.json"))
  cloud  = contains(["development", "staging", "production"], var.environment)
  count  = local.cloud ? 1 : 0
  queues = local.cloud ? merge(
    { for key, queue in local.config.resources.queues : key => queue.name },
    { for key, queue in local.config.resources.queues : "${key}-dlq" => queue.deadLetter }
  ) : {}
  # The one Neon API role, and the database roles it creates with SQL: every other declared role.
  api_roles = local.cloud ? { migrations = local.config.resources.database.roles.migrations } : {}
  restricted_roles = local.cloud ? {
    for key, name in local.config.resources.database.roles : key => name if key != "migrations"
  } : {}
  role_passwords = merge(
    { for key, role in neon_role.database : key => role.password },
    { for key, generated in random_password.database : key => generated.result },
  )
  # The zone's rate-limiting rule, chosen by the environment's Cloudflare zone plan. A Free zone
  # allows only the Path field with 10-second periods and timeouts, so its rule counts the runtime
  # API on every host of the zone. A paid zone (Pro and up) counts the runtime host per minute.
  rate_limit_rule = {
    free = {
      expression         = "http.request.uri.path wildcard \"/v1/*\""
      period             = 10
      requests           = ceil(local.config.budgets.requestsPerMinute / 6)
      mitigation_timeout = 10
    }
    paid = {
      expression         = "http.host eq \"${local.config.domains.runtime}\""
      period             = 60
      requests           = local.config.budgets.requestsPerMinute
      mitigation_timeout = 60
    }
  }[local.config.cloudflareZonePlan]
}
# Local and CI deliberately create no cloud resources.
resource "cloudflare_queue" "runtime" {
  for_each   = local.queues
  account_id = local.config.safeIds.cloudflareAccountId
  queue_name = each.value
  settings   = { message_retention_period = local.config.retention.queueSeconds }
}
resource "cloudflare_r2_bucket" "artifacts" {
  for_each   = local.cloud ? local.config.resources.buckets : {}
  account_id = local.config.safeIds.cloudflareAccountId
  name       = each.value
}
resource "cloudflare_r2_bucket_lifecycle" "retention" {
  for_each    = cloudflare_r2_bucket.artifacts
  account_id  = local.config.safeIds.cloudflareAccountId
  bucket_name = each.value.name
  rules = [{
    id         = "expire-artifacts"
    enabled    = true
    conditions = { prefix = "ephemeral/" }
    delete_objects_transition = {
      condition = { type = "Age", max_age = local.config.retention.artifactDays * 86400 }
    }
  }]
}
resource "neon_project" "world" {
  count             = local.count
  name              = local.config.resources.database.project
  region_id         = local.config.resources.database.region
  pg_version        = 18
  history_retention = local.config.retention.databaseSeconds
  branch = {
    name      = local.config.resources.database.branch
    protected = var.environment == "production"
    endpoint = {
      min_cu = local.config.budgets.databaseMinCu
      max_cu = local.config.budgets.databaseMaxCu
      # 0 = the plan's default (scale to zero after 5 minutes). Neon's Free plan refuses any
      # explicit value ("not permitted on this account"). Always-on (-1) needs a paid plan.
      suspend_timeout = 0
    }
  }
  lifecycle { prevent_destroy = true }
}
# Only the migration role is a Neon API role. Neon makes every role it creates through its API a
# member of neon_superuser, which reads and writes all data, and a non-superuser cannot revoke that
# (https://neon.com/docs/manage/roles). The restricted roles are therefore created with SQL by the
# migration role (scripts/database/deployment-grants.sql) from the passwords generated here. A
# state holding an API role for another key is outside the owned addresses, and the deploy's plan
# review refuses its deletion like every other.
resource "neon_role" "database" {
  for_each   = local.api_roles
  project_id = neon_project.world[0].id
  branch_id  = neon_project.world[0].branch.id
  name       = each.value
}
resource "random_password" "database" {
  for_each    = local.restricted_roles
  length      = 48
  special     = false
  min_lower   = 1
  min_upper   = 1
  min_numeric = 1
}
resource "neon_database" "world" {
  count      = local.count
  project_id = neon_project.world[0].id
  branch_id  = neon_project.world[0].branch.id
  name       = local.config.resources.database.database
  owner_name = neon_role.database["migrations"].name
  lifecycle { prevent_destroy = true }
}
resource "cloudflare_hyperdrive_config" "world" {
  count      = local.cloud && (var.preserve_bindings || var.activation_stage != "provision") ? 1 : 0
  account_id = local.config.safeIds.cloudflareAccountId
  name       = local.config.resources.hyperdrive
  origin = {
    database = neon_database.world[0].name
    host     = neon_project.world[0].branch.endpoint.host
    user     = local.config.resources.database.roles.runtime
    password = local.role_passwords["runtime"]
    port     = 5432
    scheme   = "postgresql"
  }
  # Journal reads must not acquire stale query-cache semantics.
  caching = { disabled = true }
}
resource "cloudflare_ai_gateway" "models" {
  count                      = local.count
  account_id                 = local.config.safeIds.cloudflareAccountId
  id                         = local.config.resources.aiGateway
  authentication             = true
  byok_only                  = true
  cache_invalidate_on_update = true
  cache_ttl                  = 0
  collect_logs               = false
  rate_limiting_interval     = 60
  rate_limiting_limit        = local.config.budgets.requestsPerMinute
  spend_limits = {
    enabled = true
    rules   = [{ limit = local.config.budgets.modelMonthlyUsd, limit_type = "cost", window = 2592000 }]
  }
}
resource "cloudflare_turnstile_widget" "public" {
  count      = local.count
  account_id = local.config.safeIds.cloudflareAccountId
  name       = local.config.resources.turnstile
  domains    = [local.config.domains.runtime]
  mode       = "managed"
}
resource "cloudflare_zero_trust_access_service_token" "operations" {
  count      = local.count
  account_id = local.config.safeIds.cloudflareAccountId
  name       = local.config.resources.serviceToken
  duration   = "8760h"
}
resource "cloudflare_dns_record" "runtime" {
  count   = local.cloud && (var.preserve_public_activation || var.activation_stage == "routing") ? 1 : 0
  zone_id = local.config.safeIds.cloudflareZoneId
  name    = local.config.domains.runtime
  type    = "CNAME"
  content = local.config.domains.dnsTarget
  ttl     = 1
  proxied = true
}
resource "cloudflare_workers_route" "runtime" {
  count   = local.cloud && (var.preserve_public_activation || var.activation_stage == "routing") ? 1 : 0
  zone_id = local.config.safeIds.cloudflareZoneId
  pattern = "${local.config.domains.runtime}/*"
  script  = local.config.resources.worker
}
resource "cloudflare_ruleset" "rate_limit" {
  count   = local.count
  zone_id = local.config.safeIds.cloudflareZoneId
  name    = "rw-${var.environment}-rate-limit"
  kind    = "zone"
  phase   = "http_ratelimit"
  rules = [{
    action     = "block"
    expression = local.rate_limit_rule.expression
    enabled    = true
    ratelimit = {
      characteristics     = ["cf.colo.id", "ip.src"]
      period              = local.rate_limit_rule.period
      requests_per_period = local.rate_limit_rule.requests
      mitigation_timeout  = local.rate_limit_rule.mitigation_timeout
    }
  }]
}
resource "cloudflare_ruleset" "waf" {
  count   = local.count
  zone_id = local.config.safeIds.cloudflareZoneId
  name    = "rw-${var.environment}-waf"
  kind    = "zone"
  phase   = "http_request_firewall_custom"
  rules = [{
    action     = "block"
    expression = "http.host eq \"${local.config.domains.runtime}\" and not ssl"
    enabled    = true
  }]
}
output "hyperdrive_id" {
  value = local.cloud && (var.preserve_bindings || var.activation_stage != "provision") ? cloudflare_hyperdrive_config.world[0].id : null
}

output "database_identity" {
  value = local.cloud ? {
    host           = neon_project.world[0].branch.endpoint.host
    database       = neon_database.world[0].name
    roles          = local.config.resources.database.roles
    authentication = local.config.authentication
  } : null
}

output "database_credentials" {
  sensitive = true
  value = local.cloud ? {
    project_id     = neon_project.world[0].id
    branch_id      = neon_project.world[0].branch.id
    host           = neon_project.world[0].branch.endpoint.host
    database       = neon_database.world[0].name
    authentication = local.config.authentication
    roles = { for key, name in local.config.resources.database.roles : key => {
      name     = name
      password = local.role_passwords[key]
    } }
  } : null
}
