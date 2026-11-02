'use strict';

const mockAxios = { get: jest.fn(), post: jest.fn() };
const mockConversation = { findByPk: jest.fn() };
const mockVoiceLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

const previousGeminiKey = process.env.GEMINI_API_KEY;
process.env.GEMINI_API_KEY = 'test-key';

jest.mock('axios', () => mockAxios);
jest.mock('../../entities', () => ({ Message: {}, Conversation: mockConversation, Customer: {} }));
jest.mock('../../../utils/structured-logger', () => ({ createLogger: () => mockVoiceLogger }));

const { processVoiceInConversation, transcribeWithGemini } = require('../voice-processing.service');

describe('voice processing log redaction', () => {
    beforeEach(() => jest.clearAllMocks());

    afterAll(() => {
        if (previousGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = previousGeminiKey;
    });

    test('logs only a safe provider error code when transcription fails', async () => {
        const sensitiveError = Object.assign(
            new Error('Response transcript for Rahim, 01711111111, Mirpur address'),
            { code: 'ECONNRESET', response: { data: { transcript: 'private transcript' } } },
        );
        mockAxios.post.mockRejectedValueOnce(sensitiveError);

        await expect(transcribeWithGemini(Buffer.from('audio'), 'auto'))
            .rejects.toMatchObject({ message: 'Transcription failed', code: 'VOICE_TRANSCRIPTION_FAILED' });

        expect(mockVoiceLogger.error).toHaveBeenCalledWith('Error calling Gemini API', { errorCode: 'ECONNRESET' });
        const logs = JSON.stringify(mockVoiceLogger.error.mock.calls);
        expect(logs).not.toContain('01711111111');
        expect(logs).not.toContain('Mirpur');
        expect(logs).not.toContain('private transcript');
    });

    test('does not log raw exception text from conversation processing', async () => {
        const sensitiveError = new Error('Failed to save Rahim phone 01711111111 and transcript secret words');
        mockAxios.post.mockResolvedValueOnce({
            data: { candidates: [{ content: { parts: [{ text: 'private transcript' }] } }] },
        });
        mockConversation.findByPk.mockResolvedValueOnce({
            message: '',
            metadata: {},
            save: jest.fn().mockRejectedValueOnce(sensitiveError),
        });

        await expect(processVoiceInConversation('conversation-1', {
            buffer: Buffer.from('audio'),
            language: 'auto',
        })).rejects.toBe(sensitiveError);

        expect(mockVoiceLogger.error).toHaveBeenCalledWith('Error processing voice in conversation', {
            conversationId: 'conversation-1',
            errorCode: 'VOICE_PROCESSING_ERROR',
        });
        const logs = JSON.stringify(mockVoiceLogger.error.mock.calls);
        expect(logs).not.toContain('01711111111');
        expect(logs).not.toContain('secret words');
        expect(logs).not.toContain('private transcript');
    });
});
