const mods = import.meta.glob('./plugins/*.ts', { eager: true }) as Record<string, { name: string }>;
export function pluginNames(): string[] { return Object.values(mods).map((m) => m.name).sort(); }
