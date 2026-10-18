const paths = {
  files: "M8 3h7l5 5v13H8V3Zm7 0v6h5M4 7v14",
  editor: "m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18",
  agents: "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z",
  branch: "M6 3v18m0-9c10 0 12-2 12-9M3 3h6M3 21h6M15 3h6",
  lock: "M5 10h14v11H5V10Zm3 0V4h8v6m-4 4v3",
} as const;

export function WorkspaceIcon({ name }: { name: keyof typeof paths }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d={paths[name]} /></svg>;
}
