import { FastifyInstance } from 'fastify';
import { execFile } from 'child_process';
import { writeFile, unlink, mkdtemp } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { logger } from '../logger.js';

const WHISPER_BIN = process.env.WHISPER_BIN
  || join(process.env.HOME || '~', '.local', 'src', 'whisper.cpp', 'build', 'bin', 'whisper-cli');
const WHISPER_MODEL = process.env.WHISPER_MODEL
  || join(process.env.HOME || '~', '.local', 'share', 'whisper', 'ggml-medium.bin');
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const VALID_LANGUAGES = ['auto', 'en', 'es', 'ca', 'ja', 'fr', 'de', 'it', 'pt', 'zh', 'ko', 'ar', 'ru'];

function runCommand(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve({ stdout, stderr });
    });
  });
}

export async function transcribeRoutes(server: FastifyInstance) {
  // POST /api/transcribe — accepts audio file, returns transcript
  server.post('/transcribe', async (request, reply) => {
    let tempDir: string | null = null;

    try {
      const data = await request.file();
      if (!data) {
        return reply.status(400).send({ error: 'No audio file uploaded' });
      }

      if (data.file.readableLength > MAX_FILE_SIZE) {
        return reply.status(413).send({ error: 'File too large (max 10MB)' });
      }

      // Read language from fields (multipart fields come before the file)
      const language = (data.fields?.language as { value?: string })?.value || 'auto';
      if (!VALID_LANGUAGES.includes(language)) {
        return reply.status(400).send({ error: `Invalid language: ${language}. Valid: ${VALID_LANGUAGES.join(', ')}` });
      }

      // Save uploaded audio to temp dir
      tempDir = await mkdtemp(join(tmpdir(), 'whisper-'));
      const inputPath = join(tempDir, 'input.webm');
      const wavPath = join(tempDir, 'input.wav');

      const chunks: Buffer[] = [];
      for await (const chunk of data.file) {
        chunks.push(chunk as Buffer);
      }
      const audioBuffer = Buffer.concat(chunks);

      if (audioBuffer.length === 0) {
        return reply.status(400).send({ error: 'Empty audio file' });
      }
      if (audioBuffer.length > MAX_FILE_SIZE) {
        return reply.status(413).send({ error: 'File too large (max 10MB)' });
      }

      await writeFile(inputPath, audioBuffer);
      logger.info({ size: audioBuffer.length, language, tempDir }, '[transcribe] received audio');

      // Convert WebM → WAV 16kHz mono
      try {
        await runCommand('ffmpeg', ['-y', '-i', inputPath, '-ar', '16000', '-ac', '1', '-f', 'wav', wavPath]);
      } catch (err) {
        logger.error({ error: String(err) }, '[transcribe] ffmpeg conversion failed');
        return reply.status(500).send({ error: 'Audio conversion failed. Ensure ffmpeg is installed.' });
      }

      // Transcribe with whisper-cli
      const whisperArgs = ['-m', WHISPER_MODEL, '-f', wavPath, '--no-timestamps', '-l', language];
      let transcript: string;

      try {
        const startTime = Date.now();
        const result = await runCommand(WHISPER_BIN, whisperArgs);
        const elapsed = Date.now() - startTime;

        // whisper-cli outputs transcript to stdout, one line per segment
        transcript = result.stdout.trim();
        logger.info({ elapsed, transcriptLength: transcript.length, language }, '[transcribe] whisper completed');
      } catch (err) {
        logger.error({ error: String(err), whisperBin: WHISPER_BIN, model: WHISPER_MODEL }, '[transcribe] whisper failed');
        return reply.status(500).send({ error: 'Transcription failed. Ensure whisper-cli and model are installed.' });
      }

      return { transcript };
    } catch (err) {
      logger.error({ error: String(err) }, '[transcribe] unexpected error');
      return reply.status(500).send({ error: 'Transcription failed' });
    } finally {
      // Clean up temp files
      if (tempDir) {
        unlink(join(tempDir, 'input.webm')).catch(() => {});
        unlink(join(tempDir, 'input.wav')).catch(() => {});
        import('fs').then(fs => fs.rmdirSync(tempDir!, { recursive: false })).catch(() => {});
      }
    }
  });
}
