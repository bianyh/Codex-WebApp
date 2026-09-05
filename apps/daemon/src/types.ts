export type ThreadStatus = "idle" | "running" | "waiting_approval" | "waiting_input" | "completed" | "failed" | "interrupted" | "unknown";

export type TurnAttachment = {
  name: string;
  path: string;
  mime: string;
  size: number;
  kind: "image" | "audio" | "file";
};

export type TurnInput = {
  text: string;
  attachments: TurnAttachment[];
};

export type ModelOption = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  isCustom?: boolean;
  inputModalities: Array<"text" | "image" | "audio">;
};

export type ThreadSummary = {
  id: string;
  title: string;
  cwd?: string;
  status: ThreadStatus;
  updatedAt?: string;
  model?: string;
  tokenUsage?: { input?: number; output?: number; total?: number };
  activeTurnId?: string;
  canInterrupt?: boolean;
  canRetry?: boolean;
  activitySource?: "console" | "external";
  rolloutPath?: string;
};

export type TimelineItem = {
  id: string;
  kind: "user" | "agent" | "reasoning" | "command" | "file_change" | "plan" | "mcp" | "system" | "unknown";
  text?: string;
  title?: string;
  status?: string;
  command?: string;
  output?: string;
  path?: string;
  diff?: string;
  items?: Array<{ text: string; completed?: boolean }>;
  startedAt?: string;
  completedAt?: string;
  metadata?: Record<string, unknown>;
};

export type PendingRequest = {
  id: string;
  kind: "command_approval" | "file_approval" | "user_input" | "permissions" | "unknown";
  title: string;
  detail?: string;
  command?: string;
  cwd?: string;
  options?: Array<{ label: string; value: string; description?: string }>;
  multiple?: boolean;
  createdAt: string;
};

export type ThreadSnapshot = {
  thread: ThreadSummary;
  items: TimelineItem[];
  pendingRequests: PendingRequest[];
  plan?: Array<{ text: string; completed?: boolean }>;
  changedFiles?: Array<{ path: string; status?: string; additions?: number; deletions?: number }>;
  diff?: string;
  tokenUsage?: { input?: number; output?: number; total?: number };
};

export type ConsoleEvent = {
  eventId: string;
  threadId?: string;
  sourceMethod: string;
  receivedAt: string;
  event: Record<string, unknown>;
};

export type AdapterCapabilities = {
  codexVersion: string;
  methods: string[];
  supportsSteer: boolean;
  supportsApprovals: boolean;
  supportsDiff: boolean;
  supportsPlan: boolean;
};
