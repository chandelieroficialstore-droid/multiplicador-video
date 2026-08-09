const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const fs = require('fs');
const os = require('os');
const path = require('path');

process.on('uncaughtException', (err) => {
  console.error('[CRASH] uncaughtException:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (err) => {
  console.error('[CRASH] unhandledRejection:', err && err.stack ? err.stack : err);
});
setInterval(() => {
  const m = process.memoryUsage();
  console.log(`[MEM] rss=${(m.rss/1024/1024).toFixed(0)}MB heapUsed=${(m.heapUsed/1024/1024).toFixed(0)}MB`);
}, 15000);

const app = express();
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 200 * 1024 * 1024 } // 200MB por arquivo
});

app.use(express.static(path.join(__dirname, 'public')));

const QUALITY = {
  rapido: { preset: 'veryfast', crf: 23 },
  padrao: { preset: 'medium',   crf: 20 },
  alta:   { preset: 'slow',     crf: 17 }
};

function probeDuration(file){
  return new Promise((resolve) => {
    const p = spawn(ffprobePath, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      file
    ]);
    let out = '';
    p.stdout.on('data', d => out += d);
    p.on('close', () => {
      const val = parseFloat(out.trim());
      resolve(isNaN(val) ? null : val);
    });
    p.on('error', () => resolve(null));
  });
}

function runFFmpeg(args){
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args);
    let stderr = '';
    p.stderr.on('data', d => { stderr += d; });
    p.on('close', code => {
      if(code === 0) resolve();
      else reject(new Error(`ffmpeg saiu com código ${code}: ${stderr.slice(-1500)}`));
    });
    p.on('error', reject);
  });
}

// gerador determinístico simples a partir de uma seed numérica
function rnd(seed){
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function cleanup(paths){
  paths.forEach(p => { if(p) fs.unlink(p, () => {}); });
}

app.post('/api/generate', upload.fields([
  { name: 'gancho', maxCount: 1 },
  { name: 'corpo', maxCount: 1 },
  { name: 'cta', maxCount: 1 }
]), async (req, res) => {
  console.log('[REQ] recebido /api/generate');
  const gancho = req.files?.gancho?.[0]?.path;
  const corpo  = req.files?.corpo?.[0]?.path;
  const cta    = req.files?.cta?.[0]?.path;
  let outPath = null;

  try{
    if(!gancho || !corpo || !cta){
      return res.status(400).json({ error: 'Faltam arquivos: envie gancho, corpo e cta.' });
    }
    console.log('[REQ] arquivos recebidos, tamanhos:',
      req.files.gancho[0].size, req.files.corpo[0].size, req.files.cta[0].size);

    const quality = QUALITY[req.body.quality] || QUALITY.padrao;
    const [W, H] = (req.body.resolution || '540x960').split('x').map(Number);
    const seed = parseInt(req.body.seed || '1', 10) || 1;
    const transitions = req.body.transitions !== 'off';

    const zoom   = (1.0  + rnd(seed)   * 0.06).toFixed(3);
    const sat    = (0.95 + rnd(seed+1) * 0.13).toFixed(3);
    const bright = (-0.02+ rnd(seed+2) * 0.04).toFixed(3);
    const speed  = (0.98 + rnd(seed+3) * 0.05).toFixed(3);

    const TRANS = 0.4;
    let canX = false, durG = null, durC = null;
    if(transitions){
      console.log('[REQ] medindo duração dos clipes...');
      durG = await probeDuration(gancho);
      durC = await probeDuration(corpo);
      canX = durG && durC && durG > TRANS*2 && durC > TRANS*2;
      console.log('[REQ] duração gancho=', durG, 'corpo=', durC, 'crossfade=', canX);
    }

    const norm = i => `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H},fps=30,setsar=1[v${i}]`;
    const audioNorm =
      `[0:a]aresample=44100,aformat=channel_layouts=stereo,loudnorm=I=-16:TP=-1.5:LRA=11[a0];` +
      `[1:a]aresample=44100,aformat=channel_layouts=stereo,loudnorm=I=-16:TP=-1.5:LRA=11[a1];` +
      `[2:a]aresample=44100,aformat=channel_layouts=stereo,loudnorm=I=-16:TP=-1.5:LRA=11[a2];`;

    let joinPart;
    if(canX){
      const off1 = durG - TRANS;
      const off2 = (durG + durC - TRANS) - TRANS;
      joinPart =
        `[v0][v1]xfade=transition=fade:duration=${TRANS}:offset=${off1.toFixed(3)}[vx1];` +
        `[vx1][v2]xfade=transition=fade:duration=${TRANS}:offset=${off2.toFixed(3)}[vc];` +
        `[a0][a1]acrossfade=d=${TRANS}[ax1];` +
        `[ax1][a2]acrossfade=d=${TRANS}[ac];`;
    } else {
      joinPart = `[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[vc][ac];`;
    }

    const filter =
      `[0:v]${norm(0)};[1:v]${norm(1)};[2:v]${norm(2)};` +
      audioNorm + joinPart +
      `[vc]scale=iw*${zoom}:ih*${zoom}:flags=lanczos,crop=${W}:${H},eq=saturation=${sat}:brightness=${bright},unsharp=3:3:0.5,setpts=PTS/${speed}[vout];` +
      `[ac]atempo=${speed}[aout]`;

    outPath = path.join(os.tmpdir(), `out_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);

    console.log('[REQ] iniciando ffmpeg...');
    await runFFmpeg([
      '-y',
      '-i', gancho, '-i', corpo, '-i', cta,
      '-filter_complex', filter,
      '-map', '[vout]', '-map', '[aout]',
      '-c:v', 'libx264', '-preset', quality.preset, '-crf', String(quality.crf), '-profile:v', 'high', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k',
      '-movflags', '+faststart',
      outPath
    ]);
    console.log('[REQ] ffmpeg concluído, enviando resposta...');

    res.setHeader('Content-Type', 'video/mp4');
    const stream = fs.createReadStream(outPath);
    stream.pipe(res);
    stream.on('close', () => cleanup([gancho, corpo, cta, outPath]));
    stream.on('error', () => cleanup([gancho, corpo, cta, outPath]));
  }catch(err){
    console.error('[REQ] erro tratado:', err && err.stack ? err.stack : err);
    cleanup([gancho, corpo, cta, outPath]);
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Servidor rodando na porta ' + PORT));
