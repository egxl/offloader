import fs from "node:fs/promises";
import path from "node:path";

const MAX_TOTAL_BYTES = 512 * 1024; // 512 KiB safety cap per offload request

function normalizeForComparison(target: string): string {
  return process.platform === "win32" ? target.toLowerCase() : target;
}

export function resolveWithinWorkspace(
  workspaceDir: string,
  targetPath: string
): { absPath: string; relPath: string } {
  const root = path.resolve(workspaceDir);
  const resolved = path.resolve(root, targetPath);

  const normRoot = normalizeForComparison(root);
  const normResolved = normalizeForComparison(resolved);
  const rootPrefix = normRoot.endsWith(path.sep) ? normRoot : normRoot + path.sep;

  if (!normResolved.startsWith(rootPrefix)) {
    throw new Error(
      `Path "${targetPath}" resolves outside workspace "${root}".`
    );
  }

  return {
    absPath: resolved,
    relPath: path.relative(root, resolved) || path.basename(resolved),
  };
}

export async function readWorkspaceFiles(
  workspaceDir: string,
  filePaths: string[],
  maxTotalBytes: number = MAX_TOTAL_BYTES
): Promise<{ contextText: string; loadedFiles: string[]; totalBytes: number }> {
  let totalBytes = 0;
  const sections: string[] = [];
  const loadedFiles: string[] = [];

  for (const rawPath of filePaths) {
    const { absPath, relPath } = resolveWithinWorkspace(workspaceDir, rawPath);
    const stat = await fs.stat(absPath);
    if (!stat.isFile()) {
      throw new Error(`"${rawPath}" is not a regular file.`);
    }

    if (totalBytes + stat.size > maxTotalBytes) {
      throw new Error(
        `Attached files exceed ${maxTotalBytes} byte limit (stopped at "${relPath}").`
      );
    }

    const content = await fs.readFile(absPath, "utf8");
    totalBytes += stat.size;
    loadedFiles.push(relPath);
    sections.push(`--- FILE: ${relPath} ---\n\`\`\`\n${content}\n\`\`\``);
  }

  return {
    contextText: sections.join("\n\n"),
    loadedFiles,
    totalBytes,
  };
}

export async function writeWorkspaceFile(
  workspaceDir: string,
  outputFile: string,
  content: string
): Promise<string> {
  const { absPath, relPath } = resolveWithinWorkspace(workspaceDir, outputFile);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, content, "utf8");
  return relPath;
}

export async function resolveWorkspaceInputFiles(
  workspaceDir: string,
  filePaths: string[]
): Promise<Array<{ absPath: string; relPath: string }>> {
  const resolved: Array<{ absPath: string; relPath: string }> = [];
  for (const rawPath of filePaths) {
    const entry = resolveWithinWorkspace(workspaceDir, rawPath);
    const stat = await fs.stat(entry.absPath);
    if (!stat.isFile()) {
      throw new Error(`"${rawPath}" is not a regular file.`);
    }
    resolved.push(entry);
  }
  return resolved;
}

export async function copyFileToWorkspace(
  workspaceDir: string,
  sourceAbsPath: string,
  outputFile: string
): Promise<{ relPath: string; absPath: string; bytes: number }> {
  const { absPath, relPath } = resolveWithinWorkspace(workspaceDir, outputFile);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.copyFile(sourceAbsPath, absPath);
  const stat = await fs.stat(absPath);
  return { relPath, absPath, bytes: stat.size };
}
