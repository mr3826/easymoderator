#!/usr/bin/env node

/**
 * Secrets Management Setup Script
 * 
 * This script helps generate secure secrets for EasyMod backend
 * and creates environment files with proper validation.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Generate cryptographically secure random strings
function generateSecureSecret(length = 64) {
  return crypto.randomBytes(length).toString('hex');
}

// Validate secret strength
function validateSecret(secret, name) {
  if (!secret || secret.length < 32) {
    throw new Error(`${name} must be at least 32 characters long`);
  }
  
  if (secret.toLowerCase().includes('change-me') || 
      secret.toLowerCase().includes('your-') ||
      secret.toLowerCase().includes('secret')) {
    throw new Error(`${name} appears to be a placeholder. Generate a secure secret.`);
  }
  
  return true;
}

// Main setup function
function setupSecrets() {
  console.log('🔐 EasyMod Backend - Secrets Setup\n');
  
  try {
    // Generate secure secrets
    const secrets = {
      JWT_ACCESS_SECRET: generateSecureSecret(64),
      JWT_REFRESH_SECRET: generateSecureSecret(64),
      SESSION_SECRET: generateSecureSecret(64),
      CSRF_SECRET: generateSecureSecret(32),
      PAYMENT_ENCRYPTION_KEY: generateSecureSecret(32),
      CHANNEL_ENCRYPTION_KEY: generateSecureSecret(32)
    };

    // Validate all secrets
    Object.entries(secrets).forEach(([key, value]) => {
      validateSecret(value, key);
    });

    // Create .env file template
    const envTemplate = `# EasyMod Backend Environment Configuration
# Generated on: ${new Date().toISOString()}

# Database Configuration
DATABASE_URL=postgresql://username:password@localhost:5432/easymod_prod
REDIS_URL=redis://localhost:6379

# Security Secrets (AUTO-GENERATED - Keep these secure!)
JWT_ACCESS_SECRET=${secrets.JWT_ACCESS_SECRET}
JWT_REFRESH_SECRET=${secrets.JWT_REFRESH_SECRET}
SESSION_SECRET=${secrets.SESSION_SECRET}
CSRF_SECRET=${secrets.CSRF_SECRET}

# Payment & Integration Security
PAYMENT_ENCRYPTION_KEY=${secrets.PAYMENT_ENCRYPTION_KEY}
CHANNEL_ENCRYPTION_KEY=${secrets.CHANNEL_ENCRYPTION_KEY}
META_APP_ID=your-meta-app-id
META_APP_SECRET=your-meta-app-secret
META_WEBHOOK_VERIFY_TOKEN=your-meta-webhook-verify-token

# Application Configuration
NODE_ENV=production
PORT=3000
CORS_ORIGINS=https://yourdomain.com
FRONTEND_URL=https://yourdomain.com

# AI & Vector Database Configuration
PINECONE_API_KEY=your-pinecone-api-key
PINECONE_INDEX=easymod-knowledge
PINECONE_NAMESPACE=knowledge_base
QDRANT_URL=http://localhost:6333
QDRANT_API_KEY=your-qdrant-api-key

# Payment Gateway Configuration
BKASH_USERNAME=your-bkash-username
BKASH_PASSWORD=your-bkash-password
BKASH_APP_KEY=your-bkash-app-key
BKASH_APP_SECRET=your-bkash-app-secret
BKASH_SANDBOX=false

# Nagad/Rocket intentionally have NO secrets here (contract D-10, ratified):
# no public official merchant API exists for either provider, no code ever
# read NAGAD_*, and collecting unread secrets is a liability. Wallet-number
# payments to them run through the self-MFS merchant-confirmation flow —
# merchant judgment, never automation.

# Monitoring & Logging
SENTRY_DSN=your-sentry-dsn
LOG_LEVEL=info

# Email Configuration (for notifications)
RESEND_API_KEY=your-resend-api-key
FROM_EMAIL=noreply@yourdomain.com

# Admin Configuration
APP_ADMIN_EMAIL=admin@yourdomain.com
`;

    // Write .env file
    const envPath = path.join(__dirname, '..', '.env');
    fs.writeFileSync(envPath, envTemplate);
    
    // Create .env.production template
    const prodEnvPath = path.join(__dirname, '..', '.env.production');
    fs.writeFileSync(prodEnvPath, envTemplate);
    
    // Create .env.staging template  
    const stagingEnvPath = path.join(__dirname, '..', '.env.staging');
    const stagingTemplate = envTemplate.replace('NODE_ENV=production', 'NODE_ENV=staging');
    fs.writeFileSync(stagingEnvPath, stagingTemplate);

    console.log('✅ Environment files created successfully!');
    console.log('\n📝 Files created:');
    console.log('   - .env (development)');
    console.log('   - .env.production');
    console.log('   - .env.staging');
    
    console.log('\n🔑 Generated Secrets:');
    Object.entries(secrets).forEach(([key, value]) => {
      console.log(`   ${key}: ${value.substring(0, 8)}...${value.substring(value.length - 4)}`);
    });
    
    console.log('\n⚠️  IMPORTANT SECURITY NOTES:');
    console.log('   1. Store these secrets in a secure password manager');
    console.log('   2. Add .env* files to .gitignore');
    console.log('   3. Use environment-specific secrets in production');
    console.log('   4. Rotate secrets regularly (every 90 days recommended)');
    console.log('   5. Use different secrets for each environment');
    
    console.log('\n🚀 Next Steps:');
    console.log('   1. Fill in your specific configuration values');
    console.log('   2. Set up environment variables in production');
    console.log('   3. Test the application with new secrets');
    console.log('   4. Deploy to production');
    
  } catch (error) {
    console.error('❌ Error setting up secrets:', error.message);
    process.exit(1);
  }
}

// Run setup if called directly
if (require.main === module) {
  setupSecrets();
}

module.exports = { setupSecrets, generateSecureSecret, validateSecret };
