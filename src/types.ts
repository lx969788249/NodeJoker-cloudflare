// Environment bindings for Cloudflare Workers
export interface Env {
  DB: D1Database;
  IMAGES: R2Bucket;
  MAX_FILE_SIZE?: string;
  DAILY_UPLOAD_LIMIT?: string;
}

// Hono context variables
export interface AppVariables {
  user: AuthUser;
}

export interface AuthUser {
  id: string;
  username: string;
  level: number;
  apiKey: string;
  sessionVersion: number;
}
