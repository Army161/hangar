#!/usr/bin/env node
'use strict';
/**
 * Build the Hangar walkthrough video.
 *
 *   node demo/make-demo.js
 *
 * Three stages, in this order for a reason:
 *
 *   1. Narrate  — render each scene's line to a WAV with Windows SAPI, then
 *                 measure it with ffprobe.
 *   2. Record   — drive the live app with Playwright, holding each shot for the
 *                 measured length of its line.
 *   3. Mux      — concatenate the audio and lay it over the video with ffmpeg.
 *
 * Measuring before recording is what keeps narration and picture in sync. The
 * usual approach — guess a duration per scene, record, then nudge — desyncs the
 * moment anyone rewords a sentence. Here the timings are derived, so editing
 * demo/script.js and re-running is the whole workflow.
 *
 * Everything is local: SAPI ships with Windows, ffmpeg and Playwright are local
 * binaries. No account, no API key, nothing uploaded.
 */

const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const OUT = path.join(HERE, 'out');
const AUDIO = path.join(OUT, 'audio');
const VIDEO = path.join(OUT, 'video');
const script = require('./script');

const VOICE = process.env.HANGAR_DEMO_VOICE || 'Microsoft Zira Desktop';
const RATE = process.env.HANGAR_DEMO_RATE || '0';   // SAPI: -10..10

function log(msg) { process.stdout.write(`${msg}\n`); }
function fresh(dir) { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }); }

// --- 1. narrate -------------------------------------------------------------

function narrate() {
  fresh(AUDIO);
  log(`\n[1/3] Narrating ${script.scenes.length} scenes with "${VOICE}"…`);

  const durations = [];
  for (const [i, scene] of script.scenes.entries()) {
    const wav = path.join(AUDIO, `${String(i).padStart(2, '0')}-${scene.id}.wav`);

    // Text goes via a file, not the command line: the script contains quotes,
    // apostrophes and em dashes, and PowerShell argument quoting cannot be
    // trusted with any of them.
    const txt = `${wav}.txt`;
    fs.writeFileSync(txt, scene.say, 'utf8');

    const ps = `
      Add-Type -AssemblyName System.Speech
      $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
      try { $s.SelectVoice('${VOICE.replace(/'/g, "''")}') } catch { }
      $s.Rate = ${Number(RATE)}
      $s.SetOutputToWaveFile('${wav.replace(/'/g, "''")}')
      $s.Speak([System.IO.File]::ReadAllText('${txt.replace(/'/g, "''")}'))
      $s.Dispose()
    `;
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'pipe' });
    fs.unlinkSync(txt);

    const sec = Number(execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', wav,
    ]).toString().trim());

    durations.push({ ...scene, wav, ms: Math.round(sec * 1000) });
    log(`      ${scene.id.padEnd(16)} ${sec.toFixed(1)}s`);
  }

  const total = durations.reduce((a, d) => a + d.ms, 0);
  log(`      total ${(total / 1000).toFixed(1)}s`);
  return durations;
}

// --- 2. record --------------------------------------------------------------

async function record(scenes) {
  const { chromium } = require('playwright');
  fresh(VIDEO);
  log('\n[2/3] Recording the app…');

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: script.meta.width, height: script.meta.height },
    recordVideo: { dir: VIDEO, size: { width: script.meta.width, height: script.meta.height } },
    colorScheme: 'dark',
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();

  await page.goto(script.meta.url, { waitUntil: 'networkidle' });
  // The first snapshot is a PowerShell round trip; without this the opening
  // shot is an empty table.
  await page.waitForSelector('.rows .row, .empty', { timeout: 30000 });
  await page.waitForTimeout(1500);

  for (const scene of scenes) {
    const started = Date.now();
    try { await scene.action(page); } catch (e) { log(`      ! ${scene.id}: ${e.message}`); }
    const remaining = scene.ms - (Date.now() - started);
    if (remaining > 0) await page.waitForTimeout(remaining);
    log(`      ${scene.id.padEnd(16)} ok`);
  }
  await page.waitForTimeout(script.meta.tailMs);

  await context.close();          // flushes the video file
  await browser.close();

  const webm = fs.readdirSync(VIDEO).find((f) => f.endsWith('.webm'));
  if (!webm) throw new Error('Playwright produced no video file');
  return path.join(VIDEO, webm);
}

// --- 3. mux -----------------------------------------------------------------

function mux(scenes, videoPath) {
  log('\n[3/3] Muxing…');

  const listFile = path.join(AUDIO, 'concat.txt');
  fs.writeFileSync(listFile,
    scenes.map((s) => `file '${s.wav.replace(/\\/g, '/')}'`).join('\n'), 'utf8');

  const voice = path.join(OUT, 'voice.wav');
  execFileSync('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', voice], { stdio: 'pipe' });

  const final = path.join(OUT, 'hangar-walkthrough.mp4');
  execFileSync('ffmpeg', [
    '-y',
    '-i', videoPath,
    '-i', voice,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '20',
    '-pix_fmt', 'yuv420p',          // required for QuickTime and most players
    '-c:a', 'aac', '-b:a', '160k',
    '-movflags', '+faststart',      // starts playing before fully downloaded
    '-shortest',
    final,
  ], { stdio: 'pipe' });

  return final;
}

// --- run --------------------------------------------------------------------

(async () => {
  // Fail early and clearly rather than recording a page of connection errors.
  try {
    execSync(`curl -sf ${script.meta.url}/api/health`, { stdio: 'pipe' });
  } catch {
    log(`\n  The agent is not answering at ${script.meta.url}`);
    log('  Start it first:  node server.js\n');
    process.exit(1);
  }

  fs.mkdirSync(OUT, { recursive: true });
  const scenes = narrate();
  const video = await record(scenes);
  const final = mux(scenes, video);

  const mb = (fs.statSync(final).size / 1024 / 1024).toFixed(1);
  const dur = execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', final,
  ]).toString().trim();

  log(`\n  Done — ${final}`);
  log(`  ${Number(dur).toFixed(1)}s, ${mb} MB\n`);
})().catch((e) => { console.error(`\n  Failed: ${e.message}\n`); process.exit(1); });
