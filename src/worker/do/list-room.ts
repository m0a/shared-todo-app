import { DurableObject } from 'cloudflare:workers';
import { clientMessageSchema, type ServerMessage } from '../../shared/ws-protocol';

interface WsAttachment {
  actorType: 'owner' | 'anon' | 'ai';
  actorId: string;
  actorName: string | null;
}

/**
 * 1リスト = 1インスタンス。全ミューテーションを直列化し、
 * D1へ書き込んだ後、接続中の全WebSocketへブロードキャストする。
 * WebSocket Hibernation API を使用。
 */
export class ListRoom extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') === 'websocket') {
      const { 0: client, 1: server } = new WebSocketPair();
      const attachment: WsAttachment = {
        actorType: (request.headers.get('X-Actor-Type') as WsAttachment['actorType']) ?? 'anon',
        actorId: request.headers.get('X-Actor-Id') ?? 'unknown',
        actorName: request.headers.get('X-Actor-Name'),
      };
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment(attachment);
      return new Response(null, { status: 101, webSocket: client });
    }
    // MCP・REST（restore等）からのミューテーションもここで受ける（フェーズ2で実装）
    return new Response('Not found', { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    const parsed = clientMessageSchema.safeParse(JSON.parse(message));
    if (!parsed.success) {
      this.send(ws, { type: 'error', message: 'invalid message' });
      return;
    }
    // フェーズ2: ここでD1へ書き込み → revision採番 → 全接続へブロードキャスト
    this.send(ws, { type: 'error', message: 'not implemented yet' });
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    ws.close();
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    ws.send(JSON.stringify(msg));
  }

  private broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      ws.send(data);
    }
  }
}
