const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Bind on all interfaces so a hosted instance (or a LAN preview) can receive
// both players. Platforms that provide PORT are supported alongside TOP10_PORT.
const HOST = process.env.TOP10_HOST || '0.0.0.0';
const PORT = Number(process.env.TOP10_PORT || process.env.PORT || 3030);
const PAGE = path.join(__dirname, 'index.html');
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_TTL_MS = 8 * 60 * 60 * 1000;
const rooms = new Map();

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('حجم الطلب أكبر من المسموح.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('تعذر قراءة البيانات المرسلة.')); }
    });
    req.on('error', reject);
  });
}

function makeCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () => ROOM_CODE_CHARS[crypto.randomInt(ROOM_CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function cleanName(value) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24) : '';
}

function cleanQuestion(question) {
  if (!question || typeof question.title !== 'string' || typeof question.text !== 'string' || !Array.isArray(question.answers) || question.answers.length < 1 || question.answers.length > 40) return null;
  const answers = question.answers.map(answer => {
    if (!answer || typeof answer.name !== 'string' || !answer.name.trim()) return null;
    const aliases = Array.isArray(answer.aliases) ? answer.aliases.filter(value => typeof value === 'string').slice(0, 30) : [];
    return { name: answer.name.slice(0, 180), aliases, detail: typeof answer.detail === 'string' ? answer.detail.slice(0, 120) : '', points: Number.isFinite(answer.points) ? Math.max(1, Math.min(100, Math.round(answer.points))) : undefined };
  });
  if (answers.some(answer => !answer)) return null;
  return { title: question.title.slice(0, 160), text: question.text.slice(0, 300), source: typeof question.source === 'string' && /^https:\/\//.test(question.source) ? question.source.slice(0, 500) : '', answers };
}

function normalize(value) {
  return String(value).toLocaleLowerCase('ar').normalize('NFD')
    .replace(/[\u064B-\u065F\u0670\u0640\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function words(value) {
  return String(value).toLocaleLowerCase('ar').normalize('NFD')
    .replace(/[\u064B-\u065F\u0670\u0640\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
}

function editDistance(left, right) {
  const a = Array.from(left), b = Array.from(right);
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const old = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = old;
    }
  }
  return row[b.length];
}

function matches(input, answer) {
  const candidate = normalize(input);
  if (!candidate) return false;
  const aliases = [answer.name, ...(answer.aliases || [])];
  return aliases.some(alias => {
    const target = normalize(alias);
    if (candidate === target) return true;
    if (Math.min(candidate.length, target.length) >= 4) {
      const compact = value => value.replace(/(.)\1+/gu, '$1');
      if (Math.min(editDistance(candidate, target), editDistance(compact(candidate), compact(target))) <= Math.max(1, Math.floor(Math.max(candidate.length, target.length) * 0.25))) return true;
    }
    return words(input).some(word => words(alias).some(targetWord => word === targetWord || (Math.min(word.length, targetWord.length) >= 4 && editDistance(word, targetWord) <= 1)));
  });
}

function snapshot(room) {
  return {
    code: room.code,
    revision: room.revision,
    phase: room.phase,
    players: room.players.map(player => ({ name: player.name })),
    questions: room.questions,
    questionIndexes: room.questionIndexes,
    roundStep: room.roundStep,
    found: room.found,
    mistakes: room.mistakes,
    questionPoints: room.questionPoints,
    totalPoints: room.totalPoints,
    notice: room.notice,
    lastEvent: room.lastEvent
  };
}

function touch(room, text, type) {
  room.revision += 1;
  room.updatedAt = Date.now();
  room.lastEvent = { text, type, revision: room.revision };
}

function closed(room) {
  return room.found.length === room.questions[room.roundStep].answers.length || room.mistakes >= 5;
}

function authorized(room, token) {
  return room.players.some(player => player.token === token);
}

function answerGuess(room, value, token) {
  if (room.phase !== 'playing' || closed(room)) return { status: 409, error: 'السؤال مغلق؛ انتقلا إلى السؤال التالي.' };
  const guess = typeof value === 'string' ? value.trim().slice(0, 100) : '';
  if (!guess) return { status: 400, error: 'اكتب إجابتك أولاً.' };
  const list = room.questions[room.roundStep].answers;
  const found = new Set(room.found);
  const index = list.findIndex((answer, i) => !found.has(i) && matches(guess, answer));
  if (index >= 0) {
    const canonicalName = normalize(list[index].name);
    const revealed = list.map((answer, i) => !found.has(i) && normalize(answer.name) === canonicalName ? i : -1).filter(i => i >= 0);
    revealed.forEach(i => found.add(i));
    room.found = [...found];
    const points = revealed.reduce((sum, i) => sum + (list[i].points ?? Math.max(1, list.length - i)), 0);
    room.questionPoints += points;
    room.totalPoints += points;
    room.notice = closed(room) ? `أكملتما السؤال وجمعتما ${room.questionPoints} نقطة. انتقلا للسؤال التالي.` : '';
    const repeated = revealed.length > 1 ? ` — ظهرت في ${revealed.length} مواضع` : '';
    touch(room, `إجابة صحيحة: ${list[index].name}${repeated} — ${points} نقاط`, 'good');
    return { state: snapshot(room) };
  }
  if (list.some((answer, i) => found.has(i) && matches(guess, answer))) {
    touch(room, 'تم اكتشاف هذه الإجابة من قبل؛ لم تُخصم فرصة.', 'neutral');
    return { state: snapshot(room) };
  }
  room.mistakes += 1;
  room.notice = room.mistakes >= 5 ? `انتهت فرصكما الخمس. حصلتما على ${room.questionPoints} نقطة في هذا السؤال.` : '';
  touch(room, room.mistakes >= 5 ? 'انتهت فرص الفريق الخمس؛ ظهرت الإجابات.' : `إجابة غير صحيحة. بقيت ${5 - room.mistakes} فرص مشتركة.`, 'bad');
  return { state: snapshot(room) };
}

function notFound(res) { json(res, 404, { error: 'لم نعثر على الغرفة. تأكد من الرمز.' }); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);
  try {
    if ((req.method === 'GET' || req.method === 'HEAD') && (pathname === '/' || pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      fs.createReadStream(PAGE).pipe(res);
      return;
    }
    if (req.method === 'POST' && pathname === '/api/rooms') {
      const body = await readJson(req);
      const name = cleanName(body.name);
      const indexes = body.questionIndexes;
      const questionInput = body.questions;
      const questions = Array.isArray(questionInput) ? questionInput.map(cleanQuestion) : [];
      if (!name) return json(res, 400, { error: 'اكتب اسم اللاعب قبل إنشاء الغرفة.' });
      if (!Array.isArray(indexes) || indexes.length < 1 || indexes.length > 5 || indexes.some(index => !Number.isInteger(index)) || new Set(indexes).size !== indexes.length || questions.length !== indexes.length || questions.some(question => !question)) return json(res, 400, { error: 'تعذر تجهيز الجولة؛ يجب أن تحتوي من سؤال إلى خمسة أسئلة.' });
      const code = makeCode();
      const token = crypto.randomBytes(24).toString('hex');
      const room = { code, players: [{ name, token }], questions, questionIndexes: indexes, roundStep: 0, found: [], mistakes: 0, questionPoints: 0, totalPoints: 0, phase: 'waiting', revision: 1, lastEvent: null, notice: '', updatedAt: Date.now() };
      rooms.set(code, room);
      return json(res, 201, { code, token, state: snapshot(room) });
    }
    const roomMatch = pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})(?:\/(join|actions))?$/i);
    if (!roomMatch) return json(res, 404, { error: 'المسار غير موجود.' });
    const code = roomMatch[1].toUpperCase();
    const action = roomMatch[2] || '';
    const room = rooms.get(code);
    if (!room || Date.now() - room.updatedAt > ROOM_TTL_MS) {
      if (room) rooms.delete(code);
      return notFound(res);
    }
    if (req.method === 'POST' && action === 'join') {
      const body = await readJson(req);
      const name = cleanName(body.name);
      if (!name) return json(res, 400, { error: 'اكتب اسمك قبل الانضمام.' });
      if (room.phase !== 'waiting' || room.players.length !== 1) return json(res, 409, { error: 'الغرفة بدأت أو امتلأت بالفعل.' });
      const token = crypto.randomBytes(24).toString('hex');
      room.players.push({ name, token });
      room.phase = 'playing';
      room.notice = '';
      touch(room, `انضم ${name}؛ بدأت الجولة.`, 'neutral');
      return json(res, 200, { code, token, state: snapshot(room) });
    }
    if (req.method === 'GET' && !action) {
      const token = url.searchParams.get('token') || '';
      if (!authorized(room, token)) return json(res, 403, { error: 'تعذر التحقق من دخولك إلى هذه الغرفة.' });
      room.updatedAt = Date.now();
      return json(res, 200, snapshot(room));
    }
    if (req.method === 'POST' && action === 'actions') {
      const body = await readJson(req);
      if (!authorized(room, body.token || '')) return json(res, 403, { error: 'تعذر التحقق من دخولك إلى هذه الغرفة.' });
      room.updatedAt = Date.now();
      if (body.type === 'guess') {
        const result = answerGuess(room, body.value, body.token);
        if (result.error) return json(res, result.status, { error: result.error });
        return json(res, 200, result.state);
      }
      if (body.type === 'reveal') {
        if (room.phase !== 'playing' || closed(room)) return json(res, 409, { error: 'يمكن كشف الإجابات بعد إغلاق السؤال.' });
        room.mistakes = 5;
        room.notice = `كُشفت الإجابات. حصل الفريق على ${room.questionPoints} نقطة في هذا السؤال.`;
        touch(room, 'ظهرت الإجابات ويمكن متابعة الجولة.', 'neutral');
        return json(res, 200, snapshot(room));
      }
      if (body.type === 'next') {
        if (room.phase !== 'playing' || !closed(room)) return json(res, 409, { error: 'أكملا السؤال أو استهلكا الفرص قبل المتابعة.' });
        room.notice = '';
        if (room.roundStep === room.questions.length - 1) {
          room.phase = 'finished';
          room.notice = `انتهت الجولة. مجموع نقاط ${room.players.map(player => player.name).join(' و ')} هو ${room.totalPoints}.`;
          touch(room, 'انتهت الأسئلة الخمسة؛ ظهر ملخص الجولة.', 'neutral');
        } else {
          room.roundStep += 1;
          room.found = [];
          room.mistakes = 0;
          room.questionPoints = 0;
          touch(room, 'بدأ السؤال التالي.', 'neutral');
        }
        return json(res, 200, snapshot(room));
      }
      return json(res, 400, { error: 'هذا الإجراء غير متاح.' });
    }
    return json(res, 405, { error: 'طريقة الطلب غير مدعومة.' });
  } catch (error) {
    if (!res.headersSent) json(res, 400, { error: error.message || 'حدث خطأ غير متوقع.' });
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) if (now - room.updatedAt > ROOM_TTL_MS) rooms.delete(code);
}, 30 * 60 * 1000).unref();

server.listen(PORT, HOST, () => {
  console.log(`TOP 10 جاهزة على http://localhost:${PORT}`);
});
