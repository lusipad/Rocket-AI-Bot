export interface ToolSource {
  type: 'file' | 'azure_devops' | 'web' | 'chat';
  title: string;
  ref: string;
  url?: string;
}

export function createFileSource(
  filePath: string,
  startLine?: number,
  endLine?: number,
  title = filePath,
): ToolSource {
  return {
    type: 'file',
    title,
    ref: formatFileRef(filePath, startLine, endLine),
  };
}

export function createAzureDevOpsSource(
  ref: string,
  url?: string,
  title = ref,
): ToolSource {
  return {
    type: 'azure_devops',
    title,
    ref,
    ...(url ? { url } : {}),
  };
}

export function dedupeSources(sources: ToolSource[]): ToolSource[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = `${source.type}|${source.ref}|${source.url ?? ''}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function formatFileRef(filePath: string, startLine?: number, endLine?: number): string {
  if (!Number.isFinite(startLine)) {
    return normalizePath(filePath);
  }

  const safeStart = Math.max(1, Math.floor(startLine as number));
  if (!Number.isFinite(endLine) || Math.floor(endLine as number) <= safeStart) {
    return `${normalizePath(filePath)}:${safeStart}`;
  }

  return `${normalizePath(filePath)}:${safeStart}-${Math.floor(endLine as number)}`;
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}
