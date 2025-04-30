// vite.config.js (or .ts)
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';

export default defineConfig({
  plugins: [vue()],
  build: {
    // Output directory (usually 'dist')
    outDir: 'dist',
    // Important: Disable minification for easier debugging during development
    // You can enable it for production builds
    minify: false,
    rollupOptions: {
      // Define multiple entry points
      input: {
        // Your popup page (adjust path if necessary)
        popup: resolve(__dirname, 'index.html'), // Assuming your popup Vue app root is index.html

        // Your background script
        background: resolve(__dirname, 'src/background.ts'), // Adjust path to your background.ts

        // Your content script
        content: resolve(__dirname, 'src/content.ts'), // Adjust path to your content.ts
      },
      output: {
        // Define output filenames
        // Use 'entryFileNames' to prevent hashing for extension files
        entryFileNames: `[name].js`,
        // For chunks, if any are created (less common for simple background/content scripts)
        chunkFileNames: `[name].js`,
        // For assets like CSS (if your content script imports CSS)
        assetFileNames: `[name].[ext]`,

        // Specify the format - 'iife' (Immediately Invoked Function Expression) is often safest
        // for content scripts, 'esm' might work for service workers but IIFE is safe too.
        // Background SW MUST be ESM if you use type: "module" in manifest.json
        // Let's use different formats if needed, or stick to one:
        format: 'es', // Use 'esm' if your background SW needs top-level await or imports outside async IIFE

        // If using different formats per entry (more complex setup):
        /*
        manualChunks: undefined, // Ensure manual chunks don't interfere unless intended
        format: (format, entryName) => {
           if (entryName === 'background') return 'esm'; // Example: ES Module for background
           return 'iife'; // IIFE for others
        },
        */
        inlineDynamicImports: false,
      },
    },
    // Ensure emptyOutDir is true to clean the dist folder on each build
    emptyOutDir: true,
  },
  // Optional: Define publicDir if you have static assets (like your model)
  // By default it's 'public', ensure your model is in 'public/model_tfjs_saved_model'
  publicDir: 'public',
});