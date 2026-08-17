// auth.js
//
// Простая регистрация/вход: ник + почта + пароль. Ник и почта уникальны
// (без учёта регистра — см. db.js). Пароли не хранятся в открытом виде —
// scrypt (встроен в Node, без дополнительных нативных зависимостей) с
// собственной случайной солью на каждый пароль.
//
// Это НЕ полноценная система авторизации (нет восстановления пароля,
// подтверждения почты, ограничения попыток входа и т.п.) — минимум,
// достаточный, чтобы у игрока была учётная запись с уникальными
// ником/почтой, а сервер мог выдать и проверить токен сессии.

const crypto = require('crypto');

const NICKNAME_RE = /^[\p{L}\p{N}_-]{3,20}$/u;
// Простая, но достаточная проверка формата почты для регистрации —
// не претендует на полное соответствие RFC 5322.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_MIN_LENGTH = 6;
const PASSWORD_MAX_LENGTH = 200; // защита от заведомо абсурдного ввода, не более того
const SCRYPT_KEYLEN = 64;

function hashPassword(password){
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored){
  const [salt, hashHex] = String(stored || '').split(':');
  if (!salt || !hashHex) return false;
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  const stored_ = Buffer.from(hashHex, 'hex');
  // timingSafeEqual требует буферы одинаковой длины — если формат хэша
  // повреждён/другой длины, это не совпадение, а не повод падать с ошибкой.
  if (stored_.length !== hash.length) return false;
  return crypto.timingSafeEqual(hash, stored_);
}

function generateSessionToken(){
  return crypto.randomBytes(32).toString('hex');
}

function normalizeNickname(nickname){
  return typeof nickname === 'string' ? nickname.trim() : '';
}
function normalizeEmail(email){
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}
// Ключ для проверки уникальности без учёта регистра. Отдельно от
// normalizeNickname(), которая только убирает пробелы по краям и
// сохраняет исходный регистр для отображения — см. комментарий в db.js
// про то, почему это не делается через SQLite COLLATE NOCASE.
function nicknameKey(nickname){
  return normalizeNickname(nickname).toLowerCase();
}

// Возвращает null, если всё корректно, иначе { field, reason }.
function validateRegistration({ nickname, email, password }){
  if (!NICKNAME_RE.test(nickname)){
    return { field: 'nickname', reason: 'invalid-nickname' };
  }
  if (!EMAIL_RE.test(email)){
    return { field: 'email', reason: 'invalid-email' };
  }
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH){
    return { field: 'password', reason: 'invalid-password' };
  }
  return null;
}

function createAuth(db){
  const insertUser = db.prepare(
    `INSERT INTO users (nickname, nickname_norm, email, email_norm, password_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const findByNickname = db.prepare(
    `SELECT * FROM users WHERE nickname_norm = ?`
  );
  const findByEmail = db.prepare(
    `SELECT * FROM users WHERE email_norm = ?`
  );
  const findById = db.prepare(`SELECT * FROM users WHERE id = ?`);
  const insertSession = db.prepare(
    `INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)`
  );
  const findSession = db.prepare(
    `SELECT sessions.token, users.id as user_id, users.nickname, users.email
       FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.token = ?`
  );
  const deleteSession = db.prepare(`DELETE FROM sessions WHERE token = ?`);

  function toPublicUser(row){
    return { id: row.id, nickname: row.nickname, email: row.email };
  }

  function createSession(userId){
    const token = generateSessionToken();
    insertSession.run(token, userId, Date.now());
    return token;
  }

  // { ok: true, user, token } | { ok: false, field, reason }
  function register({ nickname, email, password }){
    nickname = normalizeNickname(nickname);
    email = normalizeEmail(email);

    const invalid = validateRegistration({ nickname, email, password });
    if (invalid) return { ok: false, ...invalid };

    const nickKey = nicknameKey(nickname);
    if (findByNickname.get(nickKey)) return { ok: false, field: 'nickname', reason: 'nickname-taken' };
    if (findByEmail.get(email)) return { ok: false, field: 'email', reason: 'email-taken' };

    const passwordHash = hashPassword(password);
    let userId;
    try {
      const info = insertUser.run(nickname, nickKey, email, email, passwordHash, Date.now());
      userId = info.lastInsertRowid;
    } catch (err){
      // Гонка: два запроса на регистрацию с одинаковым ником/почтой почти
      // одновременно проходят проверку выше до того, как второй вставится —
      // тогда ловим уникальный индекс и превращаем его в понятную причину.
      if (String(err.message).includes('idx_users_nickname_norm')){
        return { ok: false, field: 'nickname', reason: 'nickname-taken' };
      }
      if (String(err.message).includes('idx_users_email_norm')){
        return { ok: false, field: 'email', reason: 'email-taken' };
      }
      throw err;
    }

    const token = createSession(userId);
    return { ok: true, user: toPublicUser(findById.get(userId)), token };
  }

  // login может быть ником или почтой. { ok, user, token } | { ok:false, reason }
  function login({ login, password }){
    const raw = typeof login === 'string' ? login.trim() : '';
    if (!raw || typeof password !== 'string'){
      return { ok: false, reason: 'invalid-credentials' };
    }
    const row = raw.includes('@') ? findByEmail.get(normalizeEmail(raw)) : findByNickname.get(nicknameKey(raw));
    if (!row || !verifyPassword(password, row.password_hash)){
      // Намеренно одна и та же причина и для "нет такого пользователя", и
      // для "неверный пароль" — чтобы не подтверждать перебором, какие
      // ники/почты зарегистрированы.
      return { ok: false, reason: 'invalid-credentials' };
    }
    const token = createSession(row.id);
    return { ok: true, user: toPublicUser(row), token };
  }

  function verifySession(token){
    if (!token) return null;
    const row = findSession.get(token);
    if (!row) return null;
    return { id: row.user_id, nickname: row.nickname, email: row.email };
  }

  function logout(token){
    deleteSession.run(token);
  }

  // Публичный поиск по нику — например, для просмотра чужой статистики.
  // Намеренно не отдаёт email (это не публичное поле).
  function findPublicUserByNickname(nickname){
    const row = findByNickname.get(nicknameKey(nickname));
    return row ? { id: row.id, nickname: row.nickname } : null;
  }

  return { register, login, verifySession, logout, findPublicUserByNickname };
}

module.exports = { createAuth, hashPassword, verifyPassword };
