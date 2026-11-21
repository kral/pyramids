export async function openPage(): Promise<string> {
  const { renderPage } = await import('./page');
  return renderPage();
}
