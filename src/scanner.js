import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions/StringSession.js';

function requireConfig(apiId, apiHash) {
  return { apiId: Number(apiId || 0), apiHash: apiHash || '' };
}

export class HistoryScanner {
  constructor({ apiId, apiHash, session = '', decrypt, encrypt, save, onStatus }) {
    const cfg = requireConfig(apiId, apiHash);
    this.apiId = cfg.apiId;
    this.apiHash = cfg.apiHash;
    this.decrypt = decrypt;
    this.encrypt = encrypt;
    this.save = save;
    this.onStatus = onStatus || (() => {});
    this.client = null;
    this.auth = null;
    this.running = false;
    this.scanAdminId = null;
    this.lastAdminId = null;
    this.sessionValue = session || '';
  }

  emit(status, extra = {}) {
    this.onStatus({ status, adminId: this.auth?.adminId || this.lastAdminId || null, ...extra });
  }

  async connectSaved() {
    if (!this.sessionValue || !this.apiId || !this.apiHash) return false;
    const session = new StringSession(this.decrypt(this.sessionValue));
    const client = new TelegramClient(session, this.apiId, this.apiHash, {
      connectionRetries: 5,
      autoReconnect: true,
      floodSleepThreshold: 60,
    });
    await client.connect();
    if (!(await client.isUserAuthorized())) {
      await client.disconnect();
      return false;
    }
    this.client = client;
    this.emit('connected');
    return true;
  }

  async beginLogin(waitFor, adminId = null) {
    if (!this.apiId || !this.apiHash) throw new Error('Missing MT_API_ID / MT_API_HASH');
    if (this.auth) throw new Error('登录流程已经在进行中');
    const session = new StringSession('');
    const client = new TelegramClient(session, this.apiId, this.apiHash, {
      connectionRetries: 5,
      autoReconnect: true,
      floodSleepThreshold: 60,
    });
    const auth = {
      adminId,
      phase: 'phone',
      resolve: null,
      reject: null,
      waitFor,
    };
    this.auth = auth;
    this.lastAdminId = adminId;

    const waitInput = async (phase) => {
      auth.phase = phase;
      this.emit('auth_waiting', { phase });
      return await new Promise((resolve, reject) => {
        auth.resolve = resolve;
        auth.reject = reject;
      });
    };

    try {
      await client.start({
        phoneNumber: () => waitInput('phone'),
        phoneCode: () => waitInput('code'),
        password: () => waitInput('password'),
        onError: (error) => this.emit('auth_error', { error: error?.message || String(error) }),
      });
      this.client = client;
      this.sessionValue = this.encrypt(client.session.save());
      await this.save(this.sessionValue);
      this.auth = null;
      this.emit('connected');
      return true;
    } catch (error) {
      this.auth = null;
      try { await client.disconnect(); } catch {}
      throw error;
    }
  }

  provide(value) {
    if (!this.auth?.resolve) return false;
    const resolve = this.auth.resolve;
    this.auth.resolve = null;
    this.auth.reject = null;
    resolve(String(value).trim());
    return true;
  }

  cancelAuth(reason = 'cancelled') {
    if (!this.auth) return;
    const reject = this.auth.reject;
    this.auth.resolve = null;
    this.auth.reject = null;
    this.auth = null;
    if (reject) reject(new Error(reason));
  }

  async getRepositoryEntity(chatId) {
    if (!this.client) throw new Error('扫描账号尚未登录');
    try {
      return await this.client.getInputEntity(String(chatId));
    } catch {
      const wanted = String(chatId);
      for await (const dialog of this.client.iterDialogs({})) {
        if (String(dialog.id) === wanted) return dialog;
      }
      throw new Error('扫描账号看不到这个仓库。请先用该 Telegram 账号加入仓库群/频道，并确认可以正常打开历史消息。');
    }
  }

  static resourceFromMessage(message, chatId) {
    const media = message?.media;
    if (!media) return null;
    const document = media.document;
    const photo = media.photo;
    if (!document && !photo) return null;

    let fileName = '';
    if (document?.attributes) {
      const attr = document.attributes.find(a =>
        a?.className === 'DocumentAttributeFilename' || a?.fileName
      );
      fileName = attr?.fileName || '';
    }

    const caption = String(message.message || '').slice(0, 500);
    const title = String(fileName || caption || (document?.mimeType || '图片资源') || '未命名资源').slice(0, 200);
    return {
      messageId: Number(message.id),
      chatId: String(chatId),
      title,
      caption,
      date: Number(message.date || Math.floor(Date.now() / 1000)),
      source: 'mtproto',
    };
  }

  async scan({ chatId, maxMessages = 50000, offsetId = 0, onResource, adminId = null }) {
    if (this.running) throw new Error('历史扫描已经在运行');
    if (!this.client) throw new Error('请先绑定扫描账号');
    if (typeof onResource !== 'function') throw new Error('历史扫描缺少资源入库处理函数');

    // 先确认仓库可访问，再锁定扫描状态；避免实体解析失败后留下假“扫描中”状态。
    const entity = await this.getRepositoryEntity(chatId);
    this.running = true;
    this.scanAdminId = adminId;

    const startedAt = Date.now();
    const stats = {
      scanned: 0,
      resources: 0,
      skipped: 0,
      errors: 0,
      startedAt,
      lastMessageId: Number(offsetId || 0),
      lastProgressAt: startedAt,
      lastMessageAt: startedAt,
      lastMessageAgeMs: 0,
    };

    let lastEmittedScanned = 0;
    let heartbeat = null;
    const emitProgress = (force = false) => {
      const now = Date.now();
      stats.lastProgressAt = now;
      stats.lastMessageAgeMs = now - stats.lastMessageAt;
      if (force || stats.scanned !== lastEmittedScanned) {
        lastEmittedScanned = stats.scanned;
        console.log('HISTORY SCAN: progress',
          'scanned=', stats.scanned,
          'resources=', stats.resources,
          'skipped=', stats.skipped,
          'errors=', stats.errors,
          'checkpoint=', stats.lastMessageId,
          'elapsedMs=', now - startedAt);
        this.emit('scan_progress', { ...stats, adminId: this.scanAdminId, elapsedMs: now - startedAt });
      } else {
        console.log('HISTORY SCAN: heartbeat',
          'scanned=', stats.scanned,
          'checkpoint=', stats.lastMessageId,
          'secondsSinceLastMessage=', Math.floor((now - stats.lastMessageAt) / 1000),
          'elapsedMs=', now - startedAt);
        this.emit('scan_heartbeat', { ...stats, adminId: this.scanAdminId, elapsedMs: now - startedAt });
      }
    };

    this.emit('scan_started', { ...stats, adminId: this.scanAdminId });
    // 即使 Telegram 正在等待下一页，外部也能看到心跳；不会把“网络等待”误判成死锁。
    heartbeat = setInterval(() => {
      if (!this.running) return;
      try { emitProgress(false); } catch (error) {
        console.warn('HISTORY SCAN heartbeat callback failed:', error?.message || String(error));
      }
    }, 15000);

    try {
      const requestedLimit = Number(maxMessages);
      const params = {
        limit: Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : undefined,
        offsetId: Number(offsetId || 0),
        waitTime: 1,
      };

      console.log('HISTORY SCAN: iterMessages 开始，chatId=', String(chatId),
        'offsetId=', params.offsetId, 'limit=', params.limit || 'all');

      for await (const message of this.client.iterMessages(entity, params)) {
        if (!this.running) break;
        stats.scanned++;
        stats.lastMessageId = Number(message?.id || stats.lastMessageId);
        stats.lastMessageAt = Date.now();

        try {
          const item = HistoryScanner.resourceFromMessage(message, chatId);
          if (!item) {
            stats.skipped++;
          } else {
            await onResource(item);
            stats.resources++;
          }
        } catch (error) {
          stats.errors++;
          this.emit('scan_item_error', {
            error: error?.message || String(error),
            messageId: stats.lastMessageId,
            scanned: stats.scanned,
            resources: stats.resources,
            errors: stats.errors,
          });
        }

        // 更频繁地保存可见进度，避免长扫描期间只显示旧的百条整数进度。
        if (stats.scanned % 50 === 0) emitProgress(true);
      }
      stats.completed = this.running;
      stats.stopReason = this.running ? 'iterator_exhausted' : 'requested_stop';
    } catch (error) {
      stats.completed = false;
      stats.stopReason = 'error';
      stats.fatalError = error?.message || String(error);
      this.emit('scan_error', {
        error: stats.fatalError,
        ...stats,
        adminId: this.scanAdminId,
        elapsedMs: Date.now() - startedAt,
      });
      throw error;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      stats.finishedAt = Date.now();
      stats.elapsedMs = stats.finishedAt - startedAt;
      stats.stopped = !this.running;
      stats.lastMessageAgeMs = stats.finishedAt - stats.lastMessageAt;
      this.running = false;
      this.scanAdminId = null;
      this.emit('scan_finished', { ...stats, adminId });
      console.log('HISTORY SCAN: finished',
        'scanned=', stats.scanned,
        'resources=', stats.resources,
        'skipped=', stats.skipped,
        'errors=', stats.errors,
        'lastMessageId=', stats.lastMessageId,
        'stopReason=', stats.stopReason || 'unknown',
        'elapsedMs=', stats.elapsedMs,
        stats.fatalError ? 'error=' + stats.fatalError : '');
    }
    return stats;
  }

  stop() {
    this.running = false;
  }
}
