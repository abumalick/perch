export interface ProcessAncestry {
  isAncestor(ancestorPid: number, pid: number): Promise<boolean>;
}
