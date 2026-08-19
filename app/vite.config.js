import { defineConfig } from 'vite';

// A static site. Nothing here needs a server: the page talks to the public RPC
// directly, which is also why it opens for somebody with no wallet, no account
// and no GEN.
export default defineConfig({ build: { outDir: 'dist' } });
