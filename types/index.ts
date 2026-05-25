export type PayoutStatus = "pending" | "sent" | "confirmed" | "failed" | "skipped";

export type Choice = "A" | "B";

export interface TaskResponse {
  task: {
    id: string;
    prompt: string;
    responseA: string;
    responseB: string;
  } | null;
  message?: string;
}

export interface SubmitRequest {
  walletAddress: string;
  taskId: string;
  choice: Choice;
  reason: string;
}

export interface SubmitResponse {
  paid: boolean;
  txHash?: string;
  explorerUrl?: string;
  reason?: string;
}

export interface MeResponse {
  walletAddress: string;
  totalEarned: string;
  rewardSymbol: string;
  submissionCount: number;
  onboardingCompleted: boolean;
}
