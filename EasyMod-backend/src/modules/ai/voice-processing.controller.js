/**
 * Voice Processing API Controller
 * 
 * Handlers for voice message transcription and configuration
 * 
 * @file ai/voice-processing.controller.js
 */

const voiceProcessingService = require('./voice-processing.service');
const { decodeAudioBase64 } = require('./voice-processing.limits');
const claimGate = require('../commercial/claim-gate.service');

class VoiceProcessingController {
  /**
   * POST /voice/transcribe
   * Manually transcribe a voice message
   * 
   * Body: { messageId: string, audioBase64: string, language?: 'auto'|'bengali'|'english'|'banglish' }
   * 
   * Returns: { success: true, transcript: string, language: string, confidence: number }
   */
  static async transcribe(req, res, next) {
    try {
      const { messageId, audioBase64, language } = req.body;

      if (!messageId || !audioBase64) {
        return res.status(400).json({
          success: false,
          error: 'messageId and audioBase64 required'
        });
      }

      // Decode only canonical, bounded base64. Buffer.from alone is permissive
      // and can silently accept malformed input or allocate oversized buffers.
      const audioBuffer = decodeAudioBase64(audioBase64);

      const result = await voiceProcessingService.transcribeWithGemini(
        audioBuffer,
        language || 'auto'
      );

      res.status(200).json({
        success: true,
        data: {
          messageId,
          transcript: result,
          language: language || 'auto'
        }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /voice/config
   * Get voice processing configuration
   */
  static async getConfig(req, res, next) {
    try {
      const shopId = req.user.shopId;
      const locale = req.query?.locale === 'en' ? 'en' : 'bn';

      // Voice transcription has no live verification, so the claim gate keeps
      // the capability unavailable until evidence is raised (ADR-0011). No
      // per-minute charge exists under the delivered-order contract.
      const transcription = claimGate.renderClaim('voice.transcription', {
        surface: 'subscription',
        locale,
        shopId,
      });

      res.status(200).json({
        success: true,
        data: {
          voiceProcessingEnabled: transcription.available === true
            && Boolean(process.env.GEMINI_API_KEY),
          supportedLanguages: ['bengali', 'english', 'banglish', 'auto'],
          model: 'gemini-1.5-flash',
          claims: {
            transcription: {
              available: transcription.available,
              render: transcription.render,
              textKey: transcription.textKey,
              contractVersion: transcription.contractVersion
            }
          }
        }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /voice/enable
   * Enable voice processing for shop
   */
  static async enable(req, res, next) {
    try {
      const shopId = req.user.shopId;

      const result = await voiceProcessingService.configureVoiceProcessing(shopId, true);

      res.status(200).json({
        success: true,
        data: result,
        message: 'Voice processing enabled'
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /voice/disable
   * Disable voice processing for shop
   */
  static async disable(req, res, next) {
    try {
      const shopId = req.user.shopId;

      const result = await voiceProcessingService.configureVoiceProcessing(shopId, false);

      res.status(200).json({
        success: true,
        data: result,
        message: 'Voice processing disabled'
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /voice/stats
   * Get voice processing statistics
   * 
   * Query: ?days=7 (default 7 days)
   */
  static async getStats(req, res, next) {
    try {
      const shopId = req.user.shopId;
      const days = parseInt(req.query.days) || 7;

      const stats = await voiceProcessingService.getVoiceProcessingStats(shopId, days);

      res.status(200).json({
        success: true,
        data: stats
      });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = VoiceProcessingController;
