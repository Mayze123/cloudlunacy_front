/**
 * Certificate Provider Factory
 *
 * Manages different certificate providers and instantiates the appropriate one
 * based on configuration settings.
 */

const SelfSignedProvider = require("./selfSignedProvider");
const AcmeProvider = require("./acmeProvider");
const logger = require("../logger").getLogger("providerFactory");
const { AppError } = require("../errorHandler");

class CertificateProviderFactory {
  /**
   * Create a certificate provider based on the specified type and configuration
   * @param {string} providerType - Type of certificate provider to create ('self-signed' or 'acme')
   * @param {Object} config - Configuration options for the provider
   * @returns {Object} An instance of the appropriate certificate provider
   */
  static createProvider(providerType, config = {}) {
    logger.info(`Creating certificate provider of type: ${providerType}`);

    switch (providerType.toLowerCase()) {
      case "self-signed":
        return new SelfSignedProvider(config);
      case "acme":
        return new AcmeProvider(config);
      default:
        throw new AppError(
          `Unsupported certificate provider type: ${providerType}`,
          400
        );
    }
  }

  /**
   * Get a list of supported certificate provider types
   * @returns {Array} List of supported provider types with metadata
   */
  static getSupportedTypes() {
    return [
      {
        id: "self-signed",
        name: "Self-Signed",
        description: "Generate self-signed certificates",
        isExternal: false,
        isDefault: true,
      },
      {
        id: "acme",
        name: "ACME (Let's Encrypt)",
        description:
          "Request certificates from Let's Encrypt or other ACME providers",
        isExternal: true,
        isDefault: false,
      },
    ];
  }

  /**
   * Get configuration template for a specific provider type
   * @param {string} providerType - Type of certificate provider
   * @returns {Object} Configuration template with default values and descriptions
   */
  static getConfigTemplate(providerType) {
    switch (providerType.toLowerCase()) {
      case "self-signed":
        return {
          validityDays: {
            type: "number",
            description: "Certificate validity period in days",
            default: 365,
            min: 1,
            max: 3650,
          },
          keySize: {
            type: "number",
            description: "RSA key size in bits",
            default: 2048,
            options: [1024, 2048, 4096],
          },
          certsDir: {
            type: "string",
            description: "Directory to store certificates",
            default: "/path/to/certs",
          },
        };

      case "acme":
        return {
          accountEmail: {
            type: "string",
            description: "Email address for ACME account registration",
            required: true,
          },
          acmeStaging: {
            type: "boolean",
            description: "Use ACME staging server (for testing)",
            default: false,
          },
          challengeType: {
            type: "string",
            description: "ACME challenge type",
            default: "http",
            options: ["http", "dns"],
          },
          webRootPath: {
            type: "string",
            description: "Path to webroot for HTTP challenge",
            default: "/var/www/html",
            required: false,
            dependsOn: { challengeType: "http" },
          },
          dnsProvider: {
            type: "string",
            description: "DNS provider for DNS challenge",
            required: false,
            dependsOn: { challengeType: "dns" },
            options: [
              "cloudflare",
              "route53",
              "digitalocean",
              "google",
              "cloudxns",
              "dnsmadeeasy",
              "luadns",
              "nsone",
              "ovh",
              "rfc2136",
            ],
          },
          dnsCredentials: {
            type: "object",
            description: "Credentials for DNS provider API access",
            required: false,
            dependsOn: { challengeType: "dns" },
          },
          certsDir: {
            type: "string",
            description: "Directory to store certificates",
            default: "/path/to/certs",
          },
        };

      default:
        throw new AppError(
          `Unsupported certificate provider type: ${providerType}`,
          400
        );
    }
  }
}

module.exports = CertificateProviderFactory;
