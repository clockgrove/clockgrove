terraform {
  required_version = "= 1.13.1"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "= 5.27.0"
    }
    neon = {
      source  = "terraform-community-providers/neon"
      version = "= 0.1.15"
    }
    random = {
      source  = "hashicorp/random"
      version = "= 3.9.1"
    }
  }
}
provider "cloudflare" {}
provider "neon" {}
