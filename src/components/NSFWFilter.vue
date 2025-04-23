<script setup lang="ts">
import { defineProps } from 'vue'

defineProps<{ msg: string }>()

async function onClick() {
  let [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  chrome.scripting.executeScript({
    target: { tabId: tab.id! },
    func: () => {
      // Change background color for demo
      document.body.style.backgroundColor = 'lightblue';

      // Scrape all images on the page
      const images = Array.from(document.querySelectorAll('img'));
      console.log('Found images:', images.map(img => img.src));

      // Set up a MutationObserver to watch for new/changed images
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.type === 'childList') {
            mutation.addedNodes.forEach(node => {
              if (node.nodeType === 1 && (node as HTMLElement).tagName === 'IMG') {
                console.log('New image added:', (node as HTMLImageElement).src);
              }
              // Also check for images inside added subtrees
              if (node.nodeType === 1) {
                (node as HTMLElement).querySelectorAll?.('img').forEach(img => {
                  console.log('New image in subtree:', (img as HTMLImageElement).src);
                });
              }
            });
          }
          if (mutation.type === 'attributes' && mutation.target instanceof HTMLImageElement && mutation.attributeName === 'src') {
            console.log('Image src changed:', mutation.target.src);
          }
        }
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src'],
      });
      console.log('Image observer activated.');
    },
  });
}

</script>

<template>
  <h1>{{ msg }}</h1>
  <div class="card">
    <button type="button" @click="onClick">Activate filter</button>
  </div>
</template>

<style scoped>
.read-the-docs {
  color: #888;
}
</style>
