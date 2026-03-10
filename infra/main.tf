# --- Existing shared resources ---

data "azurerm_resource_group" "main" {
  name = "rg-leads-run-dev"
}

data "azurerm_container_registry" "main" {
  name                = "leadsrundevacr"
  resource_group_name = data.azurerm_resource_group.main.name
}

data "azurerm_log_analytics_workspace" "main" {
  name                = "log-leads-run-dev"
  resource_group_name = data.azurerm_resource_group.main.name
}

data "azurerm_key_vault" "main" {
  name                = "kv-leads-run-dev"
  resource_group_name = data.azurerm_resource_group.main.name
}

data "azuread_client_config" "current" {}

data "azuread_application" "github_actions" {
  display_name = "github-actions-leads-run-dev"
}

# --- API Key in Key Vault ---

resource "azurerm_key_vault_secret" "scraper_api_key" {
  name         = "scraper-api-key"
  value        = var.scraper_api_key
  key_vault_id = data.azurerm_key_vault.main.id
}

# --- Container Apps Environment (no VNet — public) ---

resource "azurerm_container_app_environment" "scraper" {
  name                       = "cae-scraper-dev"
  location                   = data.azurerm_resource_group.main.location
  resource_group_name        = data.azurerm_resource_group.main.name
  log_analytics_workspace_id = data.azurerm_log_analytics_workspace.main.id
}

# --- Container App ---

resource "azurerm_container_app" "scraper" {
  name                         = "ca-scraper-dev"
  container_app_environment_id = azurerm_container_app_environment.scraper.id
  resource_group_name          = data.azurerm_resource_group.main.name
  revision_mode                = "Single"

  identity {
    type = "SystemAssigned"
  }

  registry {
    server   = data.azurerm_container_registry.main.login_server
    identity = "SystemAssigned"
  }

  secret {
    name                = "api-key"
    key_vault_secret_id = azurerm_key_vault_secret.scraper_api_key.versionless_id
    identity            = "SystemAssigned"
  }

  template {
    min_replicas = 0
    max_replicas = 3

    container {
      name   = "scraper"
      image  = "${data.azurerm_container_registry.main.login_server}/scraper:latest"
      cpu    = 1.0
      memory = "2Gi"

      env {
        name  = "PORT"
        value = "3000"
      }

      env {
        name        = "API_KEY"
        secret_name = "api-key"
      }

      liveness_probe {
        transport = "HTTP"
        path      = "/health"
        port      = 3000
      }

      readiness_probe {
        transport = "HTTP"
        path      = "/health"
        port      = 3000
      }

      startup_probe {
        transport               = "HTTP"
        path                    = "/health"
        port                    = 3000
        failure_count_threshold = 30
        timeout                 = 3
        interval_seconds        = 2
      }
    }

    http_scale_rule {
      name                = "http-scaling"
      concurrent_requests = "10"
    }
  }

  ingress {
    external_enabled = true
    target_port      = 3000
    transport        = "http"

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }
}

# --- Role Assignments ---

# Container App pulls images from ACR
resource "azurerm_role_assignment" "scraper_acr_pull" {
  scope                = data.azurerm_container_registry.main.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_container_app.scraper.identity[0].principal_id
}

# Container App reads secrets from Key Vault
resource "azurerm_role_assignment" "scraper_kv_reader" {
  scope                = data.azurerm_key_vault.main.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_container_app.scraper.identity[0].principal_id
}

# --- GitHub OIDC for this repo ---

resource "azuread_application_federated_identity_credential" "github_scraper" {
  application_id = data.azuread_application.github_actions.id
  display_name   = "github-scraper-main-branch"
  audiences      = ["api://AzureADTokenExchange"]
  issuer         = "https://token.actions.githubusercontent.com"
  subject        = "repo:zygmunt-pawel/scraper:ref:refs/heads/main"
}
