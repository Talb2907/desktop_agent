const path = require('path');
const Database = require('better-sqlite3');

let db = null;

function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

function initDb(userDataPath) {
  const dbPath = path.join(userDataPath, 'agent-memory.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at  INTEGER NOT NULL,
      user_msg    TEXT    NOT NULL,
      agent_reply TEXT    NOT NULL,
      tool_calls  TEXT    DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS memories (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at  INTEGER NOT NULL,
      content     TEXT    NOT NULL,
      embedding   BLOB    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversation_embeddings (
      conversation_id INTEGER PRIMARY KEY REFERENCES conversations(id),
      embedding       BLOB NOT NULL
    );
  `);

  return db;
}

function saveConversation(userMsg, agentReply, toolCalls = []) {
  const result = getDb()
    .prepare('INSERT INTO conversations (created_at, user_msg, agent_reply, tool_calls) VALUES (?, ?, ?, ?)')
    .run(Date.now(), userMsg, agentReply, JSON.stringify(toolCalls));
  return result.lastInsertRowid;
}

function saveMemory(content, embedding) {
  const buf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  const result = getDb()
    .prepare('INSERT INTO memories (created_at, content, embedding) VALUES (?, ?, ?)')
    .run(Date.now(), content, buf);
  return result.lastInsertRowid;
}

function getRecentConversations(limit = 10) {
  return getDb()
    .prepare('SELECT id, created_at, user_msg, agent_reply, tool_calls FROM conversations ORDER BY created_at DESC LIMIT ?')
    .all(limit);
}

function getAllMemories() {
  return getDb()
    .prepare('SELECT id, created_at, content, embedding FROM memories')
    .all()
    .map(bufToEmbedding);
}

function getConversationsWithoutEmbeddings() {
  return getDb()
    .prepare(`
      SELECT c.id, c.created_at, c.user_msg, c.agent_reply FROM conversations c
      LEFT JOIN conversation_embeddings ce ON ce.conversation_id = c.id
      WHERE ce.conversation_id IS NULL
      ORDER BY c.created_at ASC
    `)
    .all();
}

function saveConversationEmbedding(conversationId, embedding) {
  const buf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  getDb()
    .prepare('INSERT OR REPLACE INTO conversation_embeddings (conversation_id, embedding) VALUES (?, ?)')
    .run(conversationId, buf);
}

function getAllConversationEmbeddings() {
  return getDb()
    .prepare(`
      SELECT c.id, c.created_at, c.user_msg, c.agent_reply, ce.embedding
      FROM conversations c
      JOIN conversation_embeddings ce ON ce.conversation_id = c.id
      ORDER BY c.created_at DESC
    `)
    .all()
    .map(bufToEmbedding);
}

// Convert a row's embedding BLOB (Buffer) to Float32Array in-place
function bufToEmbedding(row) {
  const buf = row.embedding;
  return {
    ...row,
    embedding: new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4),
  };
}

module.exports = {
  initDb,
  saveConversation,
  saveMemory,
  getRecentConversations,
  getAllMemories,
  getConversationsWithoutEmbeddings,
  saveConversationEmbedding,
  getAllConversationEmbeddings,
};
