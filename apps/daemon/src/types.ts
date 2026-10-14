export type ThreadStatus = "idle" | "running" | "waiting_approval" | "waiting_input" | "completed" | "failed" | "interrupted" | "unknown";

export type GoalStatus = "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete" | "unknown";
export type Goal = { threadId: string; objective: string; status: GoalStatus; tokenBudget: number | null; tokensUsed: number; timeUsedSeconds: number; createdAt?: string; updatedAt?: string };
export type GoalState = { goal: Goal | null; supported: boolean; canControl: boolean; controlReason?: string; error?: string };

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
  supportedReasoningEfforts?: Array<{ reasoningEffort: string; description: string }>;
  defaultReasoningEffort?: string;
  serviceTiers?: Array<{ id: string; name: string; description: string }>;
  defaultServiceTier?: string | null;
};

export type ExecutionSettings = { model?: string; effort?: string; serviceTier?: string; mode?: "default" | "plan" };
export type RuntimeSettings = ExecutionSettings & { modelProvider?: string; approvalPolicy?: string; sandbox?: string; reroutedFrom?: string; rerouteReason?: string };
export type TokenUsage = { input?: number; output?: number; total?: number; cachedInput?: number; reasoningOutput?: number; last?: { input?: number; output?: number; total?: number; cachedInput?: number; reasoningOutput?: number }; modelContextWindow?: number };
export type QueueEntry = TurnInput & ExecutionSettings & { id: string; createdAt?: string };
export type InventoryEntry = { id: string; name: string; status?: string; description?: string; path?: string; toolCount?: number };
export type StatusSection = { available: boolean; error?: string; entries: InventoryEntry[] };
export type QuotaWindow = { usedPercent: number; windowDurationMins?: number; resetsAt?: number };
export type Quota = { id: string; name: string; planType?: string; reached?: string; primary?: QuotaWindow; secondary?: QuotaWindow };
export type RuntimeInventory = { quotas: { available: boolean; error?: string; ordinaryUsageAllowed?: boolean | null; entries: Quota[] }; mcp: StatusSection; skills: StatusSection; plugins: StatusSection; hooks: StatusSection };

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
  runtimeSettings?: RuntimeSettings;
};

export type TimelineItem = {
  id: string;
  queueId?: string;
  kind: "user" | "agent" | "reasoning" | "command" | "file_change" | "plan" | "mcp" | "system" | "unknown" | "agents" | "search" | "image" | "review" | "sleep" | "compaction";
  createdAt?: string;
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
  durationMs?: number;
  exitCode?: number;
  agentThreads?: Array<{ id: string; name?: string; status?: string; message?: string }>;
  links?: Array<{ title: string; url: string; snippet?: string }>;
  imageData?: string;
};

export type PendingRequest = {
  id: string | number;
  method?: string;
  kind: "command_approval" | "file_approval" | "user_input" | "permissions" | "tool_call" | "elicitation" | "unknown";
  title: string;
  detail?: string;
  command?: string;
  cwd?: string;
  questions?: Array<{ id: string; header?: string; question: string; isSecret?: boolean; options?: Array<{ label: string; description?: string }> | null }>;
  tool?: string;
  arguments?: unknown;
  permissions?: Record<string, unknown>;
  requestedSchema?: unknown;
  url?: string;
  options?: Array<{ label: string; value: string; description?: string }>;
  multiple?: boolean;
  createdAt: string;
};

export type ThreadSnapshot = {
  thread: ThreadSummary;
  items: TimelineItem[];
  pendingRequests: PendingRequest[];
  goalState?: GoalState;
  plan?: Array<{ text: string; completed?: boolean }>;
  changedFiles?: Array<{ path: string; status?: string; additions?: number; deletions?: number }>;
  diff?: string;
  tokenUsage?: TokenUsage;
  compaction?: "running" | "completed" | "failed";
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
