export interface IdGenerator {
  // A new workspace id for a workspace in this folder.
  next(projectPath: string): Promise<string>;
}
