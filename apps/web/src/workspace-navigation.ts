export type WorkspaceView = "consult" | "commands" | "runs";

export interface WorkspaceNavItem {
  view: WorkspaceView;
  label: string;
}

export const workspaceNavItems: WorkspaceNavItem[] = [
  { view: "consult", label: "相談" },
  { view: "commands", label: "コマンド" },
  { view: "runs", label: "Run履歴" },
];

export function canUseConsultationDrawer(view: WorkspaceView): boolean {
  return view === "consult";
}
