output "scraper_url" {
  description = "Scraper public URL"
  value       = "https://${azurerm_container_app.scraper.ingress[0].fqdn}"
}

output "scraper_fqdn" {
  description = "Scraper FQDN"
  value       = azurerm_container_app.scraper.ingress[0].fqdn
}
