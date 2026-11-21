import readme from '../README.md?raw';
export function helpText(): string { return readme.split('\n')[1]; }
