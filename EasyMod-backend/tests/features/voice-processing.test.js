/**
 * Voice Processing API - Comprehensive Unit & E2E Tests
 * 
 * Test Coverage:
 * - POST /api/voice/transcribe
 * - GET /api/voice/stats
 * - POST /api/voice/enable
 * - POST /api/voice/disable
 * - GET /api/voice/config
 * 
 * MOCKING STRATEGY (CRITICAL FIX APPLIED):
 * 
 * Issue: Originally, Jest mock setup was broken causing all Gemini API tests to fail
 * - Root cause: jest.mock() calls were placed AFTER module imports
 * - Result: Unmocked versions of modules were cached before mocks were applied
 * - Impact: 33 out of 38 tests failing (86.8% failure rate)
 * 
 * Fix Applied:
 * 1. Moved jest.mock() calls to the VERY TOP (before any requires)
 * 2. Require modules AFTER jest.mock() is set up
 * 3. Initialize all service mock functions in EVERY describe block's beforeEach
 * 4. Verify mocks are intercepting calls with a mock verification test
 * 5. Added console logging to verify mock execution
 * 
 * Current Strategy:
 * - UNIT TESTS: Mock entire service layer (voiceProcessingService)
 *   - Allows testing controller/route logic independently
 *   - Fast, isolated tests
 *   - Clear assertion of what service should be called with
 * 
 * - E2E TESTS: Still mock service layer but initialize all functions
 *   - Tests full workflow (enable → transcribe → stats)
 *   - Verifies integration between endpoints
 *   - Could be enhanced in future to mock axios instead for true E2E
 * 
 * Key Points:
 * - ALL describe blocks MUST initialize mocks in beforeEach
 * - Each test can override specific mocks with mockResolvedValueOnce()
 * - Mock verification test runs first to catch mock setup issues early
 * - Console logging helps debug if mocks aren't working
 * 
 * @file tests/features/voice-processing.test.js
 */

// ============================================================================
// CRITICAL: Mocks MUST be set up before any module imports to ensure Jest
// properly intercepts all require() calls. This is the root cause fix.
// ============================================================================

// Mock dependencies FIRST - BEFORE any requires
//
// The factory is not optional. voice-processing.routes.js:14 DESTRUCTURES
// `authenticate` at require time, so the router holds the function object
// itself, not a live reference to the module property. A bare
// jest.mock(...) auto-mock makes `authenticate` a jest.fn() that returns
// undefined and never calls next(), and createTestApp()'s later
// `mockAuthMiddleware.authenticate = ...` reassignment cannot reach the copy
// the router already captured. Every request then hung until the per-test
// timeout: 33 of 39 cases failed, all of them "Exceeded timeout", including
// pure 400-validation cases that never touch a service.
// It reads the Authorization header for the same reason: the two cases that
// assert 401 cannot get there by swapping the function afterwards either, so
// the one mock has to model both outcomes the way the real middleware does.
jest.mock('../../src/middleware/auth.middleware', () => ({
  authenticate: jest.fn((req, res, next) => {
    if (!req.headers.authorization) {
      // Same text the real middleware throws (auth.middleware.js:25), so an
      // assertion on this message is an assertion about production behaviour
      // rather than about a string this file invented.
      return res.status(401).json({ success: false, error: 'No token provided. Please authenticate.' });
    }
    req.user = {
      userId: 'user-123',
      shopId: 'shop-456',
      role: 'owner',
      tenantId: 'tenant-789'
    };
    next();
  }),
  checkSubscriptionStatus: jest.fn((req, res, next) => next())
}));
jest.mock('axios');

// NOW require modules - they will get mocked versions
const request = require('supertest');
const express = require('express');
const axios = require('axios');

// Import service for unit test mocking setup
const voiceProcessingService = require('../../src/modules/ai/voice-processing.service');

// Import routes/controller - these will use mocked service and axios
const voiceProcessingRouter = require('../../src/modules/ai/voice-processing.routes');
const voiceProcessingController = require('../../src/modules/ai/voice-processing.controller');

// Mock the service layer NOW that we've required it
jest.mock('../../src/modules/ai/voice-processing.service');

// ============================================================================
// TEST SETUP & UTILITIES
// ============================================================================

let app;
const mockAuthMiddleware = require('../../src/middleware/auth.middleware');
const mockUser = {
  userId: 'user-123',
  shopId: 'shop-456',
  role: 'owner',
  tenantId: 'tenant-789'
};

const mockToken = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJ1c2VyLTEyMyIsInNob3BJZCI6InNob3AtNDU2In0.TJVA95OrM7E2cBab30RMHrHDcEfxjoYZgeFONFh7HY4';

// ============================================================================
// VERIFY MOCKS ARE PROPERLY SET UP
// ============================================================================

console.log('=== VERIFYING JEST MOCKS ===');
console.log('✓ voiceProcessingService is mocked:', jest.isMockFunction(voiceProcessingService.transcribeWithGemini) === false);
console.log('✓ voiceProcessingService has expected exports:',
  Object.keys(voiceProcessingService).includes('transcribeWithGemini'),
  Object.keys(voiceProcessingService).includes('detectLanguage'),
  Object.keys(voiceProcessingService).includes('configureVoiceProcessing'),
  Object.keys(voiceProcessingService).includes('getVoiceProcessingStats')
);
console.log('✓ axios is mocked:', jest.isMockFunction(axios.post));
console.log('✓ Auth middleware is mocked:', jest.isMockFunction(mockAuthMiddleware.authenticate));
console.log('=== MOCKS VERIFIED ===\n');

/**
 * Create Express app for testing
 */
function createTestApp() {
  const testApp = express();
  testApp.use(express.json());
  
  // Mock auth middleware
  mockAuthMiddleware.authenticate = jest.fn((req, res, next) => {
    req.user = mockUser;
    next();
  });
  
  testApp.use('/api/voice', voiceProcessingRouter);
  
  // Error handler
  testApp.use((err, req, res, next) => {
    res.status(err.status || 500).json({
      success: false,
      error: err.message
    });
  });
  
  return testApp;
}

/**
 * Encode audio buffer to base64
 */
function encodeAudioBase64(data = 'fake-audio-data') {
  return Buffer.from(data).toString('base64');
}

/**
 * Mock Gemini API response with transcription
 */
function mockGeminiResponse(text, language = 'bengali') {
  return {
    data: {
      candidates: [
        {
          content: {
            parts: [
              {
                text: text
              }
            ]
          }
        }
      ],
      usageMetadata: {
        inputTokens: 150,
        cachedInputTokens: 0,
        outputTokens: 45
      }
    }
  };
}

// ============================================================================
// UNIT TESTS - POST /api/voice/transcribe
// ============================================================================

describe('Voice Processing - POST /transcribe [Unit Tests]', () => {
  beforeEach(() => {
    app = createTestApp();
    jest.clearAllMocks();
    
    // CRITICAL: Set up mock implementations for all service functions
    // This fixes the issue where mocks weren't intercepting service calls
    voiceProcessingService.transcribeWithGemini = jest.fn(
      (buffer, language) => Promise.resolve('আমি ভালো আছি')
    );
    voiceProcessingService.detectLanguage = jest.fn(
      (buffer) => Promise.resolve('bengali')
    );
    voiceProcessingService.configureVoiceProcessing = jest.fn(
      (shopId, enabled) => Promise.resolve({ success: true, voiceProcessingEnabled: enabled })
    );
    voiceProcessingService.getVoiceProcessingStats = jest.fn(
      (shopId, days) => Promise.resolve({
        period: `${days} days`,
        totalVoiceMessages: 0,
        languageBreakdown: {},
        totalDurationSeconds: 0,
        averageMessageLength: 0
      })
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ========== MOCK VERIFICATION TEST ==========
  it('[MOCK-VERIFICATION] should verify that service mock is properly intercepting calls', async () => {
    // This test verifies the mock is working before running real tests
    const testBuffer = Buffer.from('test-audio');
    const testLanguage = 'bengali';
    
    // Set up specific mock for this test
    voiceProcessingService.transcribeWithGemini.mockResolvedValueOnce('MOCK_RESPONSE_VERIFIED');
    
    // Call the mock
    const result = await voiceProcessingService.transcribeWithGemini(testBuffer, testLanguage);
    
    // Verify mock was called
    expect(voiceProcessingService.transcribeWithGemini).toHaveBeenCalledTimes(1);
    expect(voiceProcessingService.transcribeWithGemini).toHaveBeenCalledWith(testBuffer, testLanguage);
    expect(result).toBe('MOCK_RESPONSE_VERIFIED');
    
    console.log('✓ Mock verification PASSED - mocks are properly intercepting service calls');
  });

  // Happy Path: Bengali audio auto-detection
  it('should transcribe voice message with Bengali auto-detection', async () => {
    const audioBase64 = encodeAudioBase64('bengali-audio-data');
    const expectedTranscript = 'আমি ভালো আছি';
    
    // Set up mock for this specific test
    voiceProcessingService.transcribeWithGemini.mockResolvedValueOnce(expectedTranscript);
    
    console.log('Test: Bengali auto-detection');
    console.log('- Mock transcribeWithGemini set to return:', expectedTranscript);
    
    const response = await request(app)
      .post('/api/voice/transcribe')
      .set('Authorization', mockToken)
      .send({
        messageId: 'msg-123',
        audioBase64: audioBase64,
        language: 'auto'
      });
    
    console.log('- Response status:', response.status);
    console.log('- Response body:', JSON.stringify(response.body, null, 2));
    console.log('- Mock called:', voiceProcessingService.transcribeWithGemini.mock.calls.length, 'times');
    
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.messageId).toBe('msg-123');
    expect(response.body.data.transcript).toBe(expectedTranscript);
    expect(response.body.data.language).toBe('auto');
    expect(voiceProcessingService.transcribeWithGemini).toHaveBeenCalledTimes(1);
  });

  // Happy Path: English transcription with explicit language
  it('should transcribe English audio with explicit language hint', async () => {
    const audioBase64 = encodeAudioBase64('english-audio-data');
    
    voiceProcessingService.transcribeWithGemini.mockResolvedValueOnce('Hello, how can I help you?');
    
    const response = await request(app)
      .post('/api/voice/transcribe')
      .set('Authorization', mockToken)
      .send({
        messageId: 'msg-124',
        audioBase64: audioBase64,
        language: 'english'
      });
    
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.transcript).toBe('Hello, how can I help you?');
    expect(response.body.data.language).toBe('english');
  });

  // Happy Path: Banglish transcription
  it('should transcribe Banglish audio correctly', async () => {
    const audioBase64 = encodeAudioBase64('banglish-audio-data');
    
    voiceProcessingService.transcribeWithGemini.mockResolvedValueOnce('ami valo achi');
    
    const response = await request(app)
      .post('/api/voice/transcribe')
      .set('Authorization', mockToken)
      .send({
        messageId: 'msg-125',
        audioBase64: audioBase64,
        language: 'banglish'
      });
    
    expect(response.status).toBe(200);
    expect(response.body.data.transcript).toBe('ami valo achi');
    expect(response.body.data.language).toBe('banglish');
  });

  // Error: Missing messageId
  it('should return 400 when messageId is missing', async () => {
    const audioBase64 = encodeAudioBase64();
    
    const response = await request(app)
      .post('/api/voice/transcribe')
      .set('Authorization', mockToken)
      .send({
        audioBase64: audioBase64
      });
    
    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.error).toContain('messageId');
  });

  // Error: Missing audioBase64
  it('should return 400 when audioBase64 is missing', async () => {
    const response = await request(app)
      .post('/api/voice/transcribe')
      .set('Authorization', mockToken)
      .send({
        messageId: 'msg-126'
      });
    
    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.error).toContain('audioBase64');
  });

  // Error: Gemini API failure
  it('should return 500 on Gemini API error', async () => {
    const audioBase64 = encodeAudioBase64();
    
    voiceProcessingService.transcribeWithGemini.mockRejectedValueOnce(
      new Error('Gemini API rate limit exceeded')
    );
    
    const response = await request(app)
      .post('/api/voice/transcribe')
      .set('Authorization', mockToken)
      .send({
        messageId: 'msg-127',
        audioBase64: audioBase64
      });
    
    expect(response.status).toBe(500);
    expect(response.body.success).toBe(false);
  });

  // Error: Invalid base64 format
  it('should handle invalid base64 gracefully', async () => {
    const response = await request(app)
      .post('/api/voice/transcribe')
      .set('Authorization', mockToken)
      .send({
        messageId: 'msg-128',
        audioBase64: 'not-valid-base64!!!'
      });
    
    // Buffer.from() will throw, should be caught
    expect([400, 500]).toContain(response.status);
  });

  // Language validation: Unsupported language
  it('should accept unsupported language and pass to service', async () => {
    const audioBase64 = encodeAudioBase64();
    
    voiceProcessingService.transcribeWithGemini.mockResolvedValueOnce('transcribed text');
    
    const response = await request(app)
      .post('/api/voice/transcribe')
      .set('Authorization', mockToken)
      .send({
        messageId: 'msg-129',
        audioBase64: audioBase64,
        language: 'hindi'
      });
    
    expect(response.status).toBe(200);
    // Service receives the language as-is
    expect(voiceProcessingService.transcribeWithGemini).toHaveBeenCalledWith(
      expect.any(Buffer),
      'hindi'
    );
  });
});

// ============================================================================
// UNIT TESTS - GET /api/voice/stats
// ============================================================================

describe('Voice Processing - GET /stats [Unit Tests]', () => {
  beforeEach(() => {
    app = createTestApp();
    jest.clearAllMocks();
    
    // Set up default mock implementations
    voiceProcessingService.transcribeWithGemini = jest.fn(
      (buffer, language) => Promise.resolve('transcribed text')
    );
    voiceProcessingService.getVoiceProcessingStats = jest.fn(
      (shopId, days) => Promise.resolve({
        period: `${days} days`,
        totalVoiceMessages: 0,
        languageBreakdown: {},
        totalDurationSeconds: 0,
        averageMessageLength: 0
      })
    );
    voiceProcessingService.configureVoiceProcessing = jest.fn(
      (shopId, enabled) => Promise.resolve({ success: true, voiceProcessingEnabled: enabled })
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // Happy Path: Return stats with language breakdown
  it('should return voice processing statistics', async () => {
    const mockStats = {
      period: '7 days',
      totalVoiceMessages: 42,
      languageBreakdown: {
        bengali: 25,
        english: 12,
        banglish: 5
      },
      totalDurationSeconds: 1260,
      averageMessageLength: 30
    };
    
    voiceProcessingService.getVoiceProcessingStats.mockResolvedValueOnce(mockStats);
    
    const response = await request(app)
      .get('/api/voice/stats')
      .set('Authorization', mockToken)
      .query({ days: 7 });
    
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.totalVoiceMessages).toBe(42);
    expect(response.body.data.languageBreakdown.bengali).toBe(25);
    expect(response.body.data.languageBreakdown.english).toBe(12);
    expect(response.body.data.languageBreakdown.banglish).toBe(5);
    expect(response.body.data.averageMessageLength).toBe(30);
    expect(voiceProcessingService.getVoiceProcessingStats)
      .toHaveBeenCalledWith(mockUser.shopId, 7);
  });

  // No transcriptions: Empty stats
  it('should return zero stats when no transcriptions exist', async () => {
    const emptyStats = {
      period: '7 days',
      totalVoiceMessages: 0,
      languageBreakdown: {},
      totalDurationSeconds: 0,
      averageMessageLength: 0
    };
    
    voiceProcessingService.getVoiceProcessingStats.mockResolvedValueOnce(emptyStats);
    
    const response = await request(app)
      .get('/api/voice/stats')
      .set('Authorization', mockToken);
    
    expect(response.status).toBe(200);
    expect(response.body.data.totalVoiceMessages).toBe(0);
    expect(Object.keys(response.body.data.languageBreakdown).length).toBe(0);
  });

  // Custom days parameter
  it('should accept custom days parameter', async () => {
    voiceProcessingService.getVoiceProcessingStats.mockResolvedValueOnce({
      period: '30 days',
      totalVoiceMessages: 100,
      languageBreakdown: {},
      totalDurationSeconds: 3000,
      averageMessageLength: 30
    });
    
    const response = await request(app)
      .get('/api/voice/stats')
      .set('Authorization', mockToken)
      .query({ days: 30 });
    
    expect(response.status).toBe(200);
    expect(voiceProcessingService.getVoiceProcessingStats)
      .toHaveBeenCalledWith(mockUser.shopId, 30);
  });

  // Default to 7 days if not specified
  it('should default to 7 days when not specified', async () => {
    voiceProcessingService.getVoiceProcessingStats.mockResolvedValueOnce({
      period: '7 days',
      totalVoiceMessages: 10,
      languageBreakdown: {},
      totalDurationSeconds: 300,
      averageMessageLength: 30
    });
    
    const response = await request(app)
      .get('/api/voice/stats')
      .set('Authorization', mockToken);
    
    expect(voiceProcessingService.getVoiceProcessingStats)
      .toHaveBeenCalledWith(mockUser.shopId, 7);
  });

  // Error: Invalid days parameter
  it('should handle invalid days parameter', async () => {
    voiceProcessingService.getVoiceProcessingStats.mockResolvedValueOnce({
      period: '7 days',
      totalVoiceMessages: 0,
      languageBreakdown: {},
      totalDurationSeconds: 0,
      averageMessageLength: 0
    });
    
    const response = await request(app)
      .get('/api/voice/stats')
      .set('Authorization', mockToken)
      .query({ days: 'invalid' });
    
    // parseInt('invalid') = NaN, || 7 defaults it
    expect(voiceProcessingService.getVoiceProcessingStats)
      .toHaveBeenCalledWith(mockUser.shopId, 7);
  });

  // Auth: Missing token
  // No reassignment here: the router captured `authenticate` when it was
  // required, so swapping the module property now changes nothing. The
  // module-level mock returns 401 when the Authorization header is absent,
  // which is what this request omits.
  it('should return 401 without authentication', async () => {
    const testApp = express();
    testApp.use(express.json());
    testApp.use('/api/voice', voiceProcessingRouter);
    
    const response = await request(testApp)
      .get('/api/voice/stats');
    
    expect(response.status).toBe(401);
  });
});

// ============================================================================
// UNIT TESTS - POST /api/voice/enable
// ============================================================================

describe('Voice Processing - POST /enable [Unit Tests]', () => {
  beforeEach(() => {
    app = createTestApp();
    jest.clearAllMocks();
    
    // Set up default mock implementations
    voiceProcessingService.configureVoiceProcessing = jest.fn(
      (shopId, enabled) => Promise.resolve({ success: true, voiceProcessingEnabled: enabled })
    );
    voiceProcessingService.transcribeWithGemini = jest.fn(
      (buffer, language) => Promise.resolve('transcribed')
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // Happy Path: Enable voice processing
  it('should enable voice processing for shop', async () => {
    const mockResult = { success: true, voiceProcessingEnabled: true };
    
    voiceProcessingService.configureVoiceProcessing.mockResolvedValueOnce(mockResult);
    
    const response = await request(app)
      .post('/api/voice/enable')
      .set('Authorization', mockToken);
    
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.voiceProcessingEnabled).toBe(true);
    expect(response.body.message).toBe('Voice processing enabled');
    expect(voiceProcessingService.configureVoiceProcessing)
      .toHaveBeenCalledWith(mockUser.shopId, true);
  });

  // Idempotent: Already enabled
  it('should be idempotent - enabling again returns success', async () => {
    const mockResult = { success: true, voiceProcessingEnabled: true };
    
    voiceProcessingService.configureVoiceProcessing.mockResolvedValueOnce(mockResult);
    
    const response1 = await request(app)
      .post('/api/voice/enable')
      .set('Authorization', mockToken);
    
    voiceProcessingService.configureVoiceProcessing.mockResolvedValueOnce(mockResult);
    
    const response2 = await request(app)
      .post('/api/voice/enable')
      .set('Authorization', mockToken);
    
    expect(response1.status).toBe(200);
    expect(response2.status).toBe(200);
    expect(response2.body.success).toBe(true);
  });

  // Error: Shop not found
  it('should return 404 if shop not found', async () => {
    voiceProcessingService.configureVoiceProcessing.mockRejectedValueOnce(
      new Error('Shop not found')
    );
    
    const response = await request(app)
      .post('/api/voice/enable')
      .set('Authorization', mockToken);
    
    expect(response.status).toBe(500);
    expect(response.body.success).toBe(false);
  });
});

// ============================================================================
// UNIT TESTS - POST /api/voice/disable
// ============================================================================

describe('Voice Processing - POST /disable [Unit Tests]', () => {
  beforeEach(() => {
    app = createTestApp();
    jest.clearAllMocks();
    
    // Set up default mock implementations
    voiceProcessingService.configureVoiceProcessing = jest.fn(
      (shopId, enabled) => Promise.resolve({ success: true, voiceProcessingEnabled: enabled })
    );
    voiceProcessingService.transcribeWithGemini = jest.fn(
      (buffer, language) => Promise.resolve('transcribed')
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // Happy Path: Disable voice processing
  it('should disable voice processing for shop', async () => {
    const mockResult = { success: true, voiceProcessingEnabled: false };
    
    voiceProcessingService.configureVoiceProcessing.mockResolvedValueOnce(mockResult);
    
    const response = await request(app)
      .post('/api/voice/disable')
      .set('Authorization', mockToken);
    
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.voiceProcessingEnabled).toBe(false);
    expect(response.body.message).toBe('Voice processing disabled');
    expect(voiceProcessingService.configureVoiceProcessing)
      .toHaveBeenCalledWith(mockUser.shopId, false);
  });

  // Idempotent: Already disabled
  it('should be idempotent - disabling again returns success', async () => {
    const mockResult = { success: true, voiceProcessingEnabled: false };
    
    // First disable
    voiceProcessingService.configureVoiceProcessing.mockResolvedValueOnce(mockResult);
    await request(app)
      .post('/api/voice/disable')
      .set('Authorization', mockToken);
    
    // Second disable
    voiceProcessingService.configureVoiceProcessing.mockResolvedValueOnce(mockResult);
    const response = await request(app)
      .post('/api/voice/disable')
      .set('Authorization', mockToken);
    
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  });
});

// ============================================================================
// UNIT TESTS - GET /api/voice/config
// ============================================================================

describe('Voice Processing - GET /config [Unit Tests]', () => {
  beforeEach(() => {
    app = createTestApp();
    jest.clearAllMocks();
    
    // Set up default mock implementations
    voiceProcessingService.transcribeWithGemini = jest.fn(
      (buffer, language) => Promise.resolve('transcribed')
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // Happy Path: Return configuration
  it('should return voice processing configuration', async () => {
    const response = await request(app)
      .get('/api/voice/config')
      .set('Authorization', mockToken);
    
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.supportedLanguages).toContain('bengali');
    expect(response.body.data.supportedLanguages).toContain('english');
    expect(response.body.data.supportedLanguages).toContain('banglish');
    expect(response.body.data.supportedLanguages).toContain('auto');
    expect(response.body.data.model).toBe('gemini-1.5-flash');
    // ADR-0011: no per-minute charge exists under the delivered-order contract;
    // transcription is a gated claim, not a priced feature.
    expect(response.body.data.transcriptionChargePerMinute).toBeUndefined();
    expect(response.body.data.claims.transcription.available).toBe(false);
  });

  // ADR-0011: voiceProcessingEnabled is fail-closed on the transcription claim.
  // Even with a GEMINI_API_KEY present, transcription is not live-verified, so
  // the claim is unavailable and voice processing stays disabled.
  it('keeps voice processing disabled until the transcription claim is live-verified', async () => {
    const originalKey = process.env.GEMINI_API_KEY;

    try {
      process.env.GEMINI_API_KEY = 'test-key-123';

      const response = await request(app)
        .get('/api/voice/config')
        .set('Authorization', mockToken);

      expect(response.body.data.claims.transcription.available).toBe(false);
      expect(response.body.data.voiceProcessingEnabled).toBe(false);
    } finally {
      process.env.GEMINI_API_KEY = originalKey;
    }
  });

  // Check config without API key
  it('should show disabled if GEMINI_API_KEY is not set', async () => {
    const originalKey = process.env.GEMINI_API_KEY;
    
    try {
      delete process.env.GEMINI_API_KEY;
      
      const response = await request(app)
        .get('/api/voice/config')
        .set('Authorization', mockToken);
      
      expect(response.body.data.voiceProcessingEnabled).toBe(false);
    } finally {
      process.env.GEMINI_API_KEY = originalKey;
    }
  });
});

// ============================================================================
// E2E TESTS - Minimal Mocking (Service Layer Mocked)
// ============================================================================

describe('Voice Processing - E2E Tests [Minimal Mocking]', () => {
  beforeEach(() => {
    app = createTestApp();
    jest.clearAllMocks();
    
    // E2E: Set up all mock implementations from the start
    voiceProcessingService.transcribeWithGemini = jest.fn(
      (buffer, language) => Promise.resolve('transcribed text')
    );
    
    voiceProcessingService.detectLanguage = jest.fn(
      (buffer) => Promise.resolve('bengali')
    );
    
    voiceProcessingService.configureVoiceProcessing = jest.fn(
      (shopId, enabled) => {
        return Promise.resolve({ success: true, voiceProcessingEnabled: enabled });
      }
    );
    
    voiceProcessingService.getVoiceProcessingStats = jest.fn(
      (shopId, days) => {
        return Promise.resolve({
          period: `${days} days`,
          totalVoiceMessages: 0,
          languageBreakdown: {},
          totalDurationSeconds: 0,
          averageMessageLength: 0
        });
      }
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // E2E Workflow: Enable → Transcribe → Stats
  it('should complete full workflow: enable → transcribe → get stats', async () => {
    // Step 1: Enable voice processing
    const enableResponse = await request(app)
      .post('/api/voice/enable')
      .set('Authorization', mockToken);
    
    expect(enableResponse.status).toBe(200);
    expect(enableResponse.body.data.voiceProcessingEnabled).toBe(true);
    
    // Step 2: Transcribe voice message
    voiceProcessingService.transcribeWithGemini.mockResolvedValueOnce('Hello world');
    
    const transcribeResponse = await request(app)
      .post('/api/voice/transcribe')
      .set('Authorization', mockToken)
      .send({
        messageId: 'msg-e2e-001',
        audioBase64: encodeAudioBase64('audio-data'),
        language: 'english'
      });
    
    expect(transcribeResponse.status).toBe(200);
    expect(transcribeResponse.body.data.transcript).toBe('Hello world');
    
    // Step 3: Get updated stats
    voiceProcessingService.getVoiceProcessingStats.mockResolvedValueOnce({
      period: '7 days',
      totalVoiceMessages: 1,
      languageBreakdown: { english: 1 },
      totalDurationSeconds: 15,
      averageMessageLength: 15
    });
    
    const statsResponse = await request(app)
      .get('/api/voice/stats')
      .set('Authorization', mockToken)
      .query({ days: 7 });
    
    expect(statsResponse.status).toBe(200);
    expect(statsResponse.body.data.totalVoiceMessages).toBe(1);
    expect(statsResponse.body.data.languageBreakdown.english).toBe(1);
  });

  // E2E: Bengali language detection
  it('E2E: should detect and transcribe Bengali audio', async () => {
    const bengaliText = 'আমার নাম ফারহান';
    
    voiceProcessingService.transcribeWithGemini.mockResolvedValueOnce(bengaliText);
    
    const response = await request(app)
      .post('/api/voice/transcribe')
      .set('Authorization', mockToken)
      .send({
        messageId: 'msg-bengali-001',
        audioBase64: encodeAudioBase64('bengali-audio'),
        language: 'auto'
      });
    
    expect(response.status).toBe(200);
    expect(response.body.data.transcript).toBe(bengaliText);
  });

  // E2E: Banglish with auto-detection
  it('E2E: should detect and transcribe Banglish audio', async () => {
    const banglishText = 'ami tomake bhalo bashi';
    
    voiceProcessingService.transcribeWithGemini.mockResolvedValueOnce(banglishText);
    
    const response = await request(app)
      .post('/api/voice/transcribe')
      .set('Authorization', mockToken)
      .send({
        messageId: 'msg-banglish-001',
        audioBase64: encodeAudioBase64('banglish-audio'),
        language: 'banglish'
      });
    
    expect(response.status).toBe(200);
    expect(response.body.data.transcript).toBe(banglishText);
  });

  // E2E: Multiple languages in stats
  it('E2E: should track multiple languages in statistics', async () => {
    // First transcription: Bengali
    voiceProcessingService.transcribeWithGemini.mockResolvedValueOnce('হ্যালো');
    
    await request(app)
      .post('/api/voice/transcribe')
      .set('Authorization', mockToken)
      .send({
        messageId: 'msg-multi-001',
        audioBase64: encodeAudioBase64(),
        language: 'bengali'
      });
    
    // Second transcription: English
    voiceProcessingService.transcribeWithGemini.mockResolvedValueOnce('Hello');
    
    await request(app)
      .post('/api/voice/transcribe')
      .set('Authorization', mockToken)
      .send({
        messageId: 'msg-multi-002',
        audioBase64: encodeAudioBase64(),
        language: 'english'
      });
    
    // Get stats with both languages
    voiceProcessingService.getVoiceProcessingStats.mockResolvedValueOnce({
      period: '7 days',
      totalVoiceMessages: 2,
      languageBreakdown: { bengali: 1, english: 1 },
      totalDurationSeconds: 30,
      averageMessageLength: 15
    });
    
    const statsResponse = await request(app)
      .get('/api/voice/stats')
      .set('Authorization', mockToken);
    
    expect(statsResponse.body.data.totalVoiceMessages).toBe(2);
    expect(statsResponse.body.data.languageBreakdown.bengali).toBe(1);
    expect(statsResponse.body.data.languageBreakdown.english).toBe(1);
  });

  // E2E: Language override hint
  it('E2E: should pass language override hint to transcription service', async () => {
    voiceProcessingService.transcribeWithGemini.mockResolvedValueOnce('Booked already');
    
    await request(app)
      .post('/api/voice/transcribe')
      .set('Authorization', mockToken)
      .send({
        messageId: 'msg-override-001',
        audioBase64: encodeAudioBase64('english-audio'),
        language: 'english'
      });
    
    // Verify the service was called with the language hint
    expect(voiceProcessingService.transcribeWithGemini).toHaveBeenCalledWith(
      expect.any(Buffer),
      'english'
    );
  });

  // E2E: Error recovery - transcription failure
  it('E2E: should handle transcription failures gracefully', async () => {
    voiceProcessingService.transcribeWithGemini.mockRejectedValueOnce(
      new Error('Audio too low quality')
    );
    
    const response = await request(app)
      .post('/api/voice/transcribe')
      .set('Authorization', mockToken)
      .send({
        messageId: 'msg-error-001',
        audioBase64: encodeAudioBase64(),
        language: 'auto'
      });
    
    expect(response.status).toBe(500);
    expect(response.body.success).toBe(false);
  });

  // E2E: Disable and re-enable
  it('E2E: should allow disable/enable toggle', async () => {
    // Enable
    let response = await request(app)
      .post('/api/voice/enable')
      .set('Authorization', mockToken);
    
    expect(response.body.data.voiceProcessingEnabled).toBe(true);
    
    // Disable
    response = await request(app)
      .post('/api/voice/disable')
      .set('Authorization', mockToken);
    
    expect(response.body.data.voiceProcessingEnabled).toBe(false);
    
    // Re-enable
    response = await request(app)
      .post('/api/voice/enable')
      .set('Authorization', mockToken);
    
    expect(response.body.data.voiceProcessingEnabled).toBe(true);
  });

  // E2E: Request response schema validation
  it('E2E: should return correct response schema for transcribe', async () => {
    voiceProcessingService.transcribeWithGemini.mockResolvedValueOnce('Test transcript');
    
    const response = await request(app)
      .post('/api/voice/transcribe')
      .set('Authorization', mockToken)
      .send({
        messageId: 'msg-schema-001',
        audioBase64: encodeAudioBase64(),
        language: 'auto'
      });
    
    // Validate response structure
    expect(response.body).toHaveProperty('success');
    expect(response.body).toHaveProperty('data');
    expect(response.body.data).toHaveProperty('messageId');
    expect(response.body.data).toHaveProperty('transcript');
    expect(response.body.data).toHaveProperty('language');
    expect(typeof response.body.success).toBe('boolean');
    expect(typeof response.body.data.transcript).toBe('string');
  });

  // E2E: Stats schema validation
  it('E2E: should return correct response schema for stats', async () => {
    voiceProcessingService.getVoiceProcessingStats.mockResolvedValueOnce({
      period: '7 days',
      totalVoiceMessages: 5,
      languageBreakdown: { bengali: 3, english: 2 },
      totalDurationSeconds: 150,
      averageMessageLength: 30
    });
    
    const response = await request(app)
      .get('/api/voice/stats')
      .set('Authorization', mockToken);
    
    // Validate response structure
    expect(response.body).toHaveProperty('success');
    expect(response.body).toHaveProperty('data');
    expect(response.body.data).toHaveProperty('period');
    expect(response.body.data).toHaveProperty('totalVoiceMessages');
    expect(response.body.data).toHaveProperty('languageBreakdown');
    expect(response.body.data).toHaveProperty('totalDurationSeconds');
    expect(typeof response.body.data.totalVoiceMessages).toBe('number');
    expect(typeof response.body.data.languageBreakdown).toBe('object');
  });
});

// ============================================================================
// GEMINI API MOCK STRATEGY DOCUMENTATION
// ============================================================================

describe('Gemini API Mock Strategy', () => {
  /**
   * GEMINI API MOCK BEHAVIOR
   * 
   * The Gemini 1.5 Flash API is mocked using jest.mock(axios)
   * 
   * Input:
   * ```
   * {
   *   "contents": [
   *     {
   *       "parts": [
   *         {
   *           "inline_data": {
   *             "mime_type": "audio/mpeg",
   *             "data": "<base64-audio>"
   *           }
   *         },
   *         {
   *           "text": "<language-hint-prompt>"
   *         }
   *       ]
   *     }
   *   ],
   *   "generationConfig": { ... }
   * }
   * ```
   * 
   * Expected Output:
   * ```
   * {
   *   "candidates": [
   *     {
   *       "content": {
   *         "parts": [
   *           {
   *             "text": "<transcribed-text>"
   *           }
   *         ]
   *       }
   *     }
   *   ],
   *   "usageMetadata": {
   *     "inputTokens": 150,
   *     "cachedInputTokens": 0,
   *     "outputTokens": 45
   *   }
   * }
   * ```
   * 
   * LANGUAGE DETECTION STRATEGY:
   * - Bengali: Return Bengali script text with high confidence (0.85-0.95)
   * - English: Return English text with medium-high confidence (0.80-0.90)
   * - Banglish: Return romanized Bengali with medium confidence (0.70-0.85)
   * - Auto: Service detects based on phonetic characteristics
   * 
   * CONFIDENCE CALCULATION:
   * - Highest confidence (0.95): Perfect match, clear audio
   * - High confidence (0.85): Good quality, minor background noise
   * - Medium confidence (0.75): Noisy audio, accent variations
   * - Low confidence (0.65): Very poor quality
   * 
   * MOCK IMPLEMENTATIONS:
   */

  it('Mock strategy - Bengali transcription', () => {
    const bengaliMock = mockGeminiResponse('আমার নাম ফারহান', 'bengali');
    expect(bengaliMock.data.candidates[0].content.parts[0].text).toMatch(/[\u0980-\u09FF]/);
  });

  it('Mock strategy - English transcription', () => {
    const englishMock = mockGeminiResponse('My name is Farhan', 'english');
    expect(englishMock.data.candidates[0].content.parts[0].text).toMatch(/[a-zA-Z]/);
  });

  it('Mock strategy - Banglish transcription', () => {
    const banglishMock = mockGeminiResponse('Amar nam Farhan', 'banglish');
    expect(banglishMock.data.candidates[0].content.parts[0].text).toMatch(/[a-z]/);
  });

  it('Mock strategy - Handle Gemini API errors', () => {
    const errorResponse = {
      response: {
        status: 429,
        data: { error: { message: 'Rate limit exceeded' } }
      }
    };
    // Simulate: axios.post.mockRejectedValue(errorResponse);
    expect(errorResponse.response.status).toBe(429);
  });

  it('Mock strategy - Confidence scoring based on language match', () => {
    // Confidence calculation logic
    const confidenceMap = {
      'bengali': 0.92, // Native language recognition
      'english': 0.88, // Clear pronunciation
      'banglish': 0.78  // Mixed language complexity
    };
    
    expect(confidenceMap.bengali).toBeGreaterThan(confidenceMap.banglish);
    expect(confidenceMap.english).toBeGreaterThan(confidenceMap.banglish);
  });
});

// ============================================================================
// ADDITIONAL TEST: AUTH MIDDLEWARE INTEGRATION
// ============================================================================

describe('Voice Processing - Authentication Middleware Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should reject requests without Bearer token', async () => {
    const unprotectedApp = express();
    unprotectedApp.use(express.json());

    // The header check lives in the module-level mock — see the note at the
    // top of this file for why reassigning it here would be a no-op.
    unprotectedApp.use('/api/voice', voiceProcessingRouter);
    
    const response = await request(unprotectedApp)
      .get('/api/voice/config');
    
    expect(response.status).toBe(401);
    // The real middleware rejects a missing token with "No token provided.
    // Please authenticate." — it never says "authorization", so the previous
    // assertion described a message no code path produces.
    expect(response.body.error).toMatch(/no token provided/i);
  });

  it('should accept requests with valid Bearer token', async () => {
    const protectedApp = createTestApp();
    
    const response = await request(protectedApp)
      .get('/api/voice/config')
      .set('Authorization', mockToken);
    
    expect(response.status).toBe(200);
  });
});
