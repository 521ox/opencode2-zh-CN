import path from "path"

export function abbreviateHome(input: string, home: string) {
  if (!home) return input
  const relative = path.relative(home, input)
  if (relative === "") return "~"
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return input
  // Normalize to forward slashes so abbreviated display paths are identical across platforms.
  return "~/" + relative.split(path.sep).join("/")
}
