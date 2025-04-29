<script setup lang="ts">
import { defineProps } from 'vue'
// import * as tf from '@tensorflow/tfjs';
// import * as tfTypes from '@tensorflow/tfjs'; 

defineProps<{ msg: string }>()

async function onClick() {
  let [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });

  let modelUrl: string;
  try {
    // This works here because we are in the extension's popup context
    modelUrl = chrome.runtime.getURL('model_tfjs_saved_model/model.json');
    console.log('Resolved model URL in popup:', modelUrl);
  } catch (error) {
    console.error('Error getting model URL:', error);
    alert(`Failed to get model URL: ${error}`); // Inform user
    return; // Don't proceed if we can't get the URL
  }


  chrome.scripting.executeScript({
    target: { tabId: tab.id! },
    args: [modelUrl],
    func: async (modelUrl) => {
      // Test with a very simple model creation
      async function testTensorflow(tf: any) {
        try {
          // Create a simple model in-memory
          const model = tf.sequential();
          model.add(tf.layers.dense({ units: 1, inputShape: [1] }));
          model.compile({ loss: 'meanSquaredError', optimizer: 'sgd' });

          // If this works, TensorFlow.js is functioning
          console.log('TensorFlow.js is working properly');
          return true;
        } catch (error) {
          console.error('Basic TensorFlow.js test failed:', error);
          return false;
        }
      }
      // async function loadTF() {
      //   try {
      //     console.log('Loading TensorFlow.js...');
      //     // @ts-ignore
      //     const tf = await import('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.21.0/dist/tf.min.js');
      //     console.log('TensorFlow.js loaded via static import:', tf.version);
      //     return tf;
      //   } catch (error) {
      //     console.error('Error loading TensorFlow.js:', error);
      //     return null;
      //   }
      // }

      async function loadTF(): Promise<any> {
        return new Promise((resolve, reject) => {
          // Check if TFJS is already loaded (e.g., by a previous execution)
          // @ts-ignore
          if (window.tf) {
            // @ts-ignore
            console.log('TensorFlow.js already loaded:', window.tf.version.tfjs);
            // @ts-ignore
            resolve(window.tf);
            return;
          }

          console.log('Injecting TensorFlow.js script...');
          const script = document.createElement('script');
          script.src = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js';
          script.async = true; // Load asynchronously

          script.onload = () => {
            // @ts-ignore
            if (window.tf) {
              // @ts-ignore
              console.log('TensorFlow.js loaded via script tag:', window.tf.version.tfjs);
              // @ts-ignore
              resolve(window.tf); // Resolve the promise with the tf object
            } else {
              console.error('TFJS script loaded but window.tf is not defined.');
              reject(new Error('TFJS script loaded but window.tf is not defined.'));
            }
          };

          script.onerror = (error) => {
            console.error('Error loading TensorFlow.js script:', error);
            reject(error); // Reject the promise on error
          };

          (document.head || document.documentElement).appendChild(script);
        });
      }
      // Then use it
      const tf: any = await loadTF(); // any type for now, TODO: define a proper type
      if (!tf) {
        console.log('TensorFlow.js could not be loaded. Exiting...');
        return;
      }
      await testTensorflow(tf);
      // Change background color for demo
      document.body.style.backgroundColor = 'lightblue';


      // Inside the injected func, right before loading the model:
      try {
        console.log('Attempting manual fetch of model JSON from:', modelUrl);
        const response = await fetch(modelUrl);
        if (!response.ok) {
          throw new Error(`Manual fetch failed: ${response.statusText}`);
        }
        const fetchedJson = await response.json();
        // Log just the first layer's config to verify the shape
        console.log('Fetched JSON:', fetchedJson);
        console.log('Manually fetched JSON - First Layer Config:', JSON.stringify(fetchedJson?.modelTopology?.model_config?.[0]?.config));
      } catch (error) {
        console.error('Error during manual fetch or tf.loadLayersModel:', error);
        return; // Stop if error occurs here
      }

      //TODO: move this to a separate file
      const labels = ['drawing', 'hentai', 'neutral', 'porn', 'sexy'];
      console.log('Loading model...');
      let model;
      try {
        console.log('Attempting to load model from:', modelUrl);
        // model = await tf.loadLayersModel(modelUrl);
        model = await tf.loadGraphModel(modelUrl); // Use loadGraphModel for TensorFlow.js
        console.log('Model loaded successfully!');
      } catch (error) {
        console.error('Error loading model:', error);
        return;
      }


      const classifyImage = async (img: HTMLImageElement) => {
        try {
          const tensor = tf.browser.fromPixels(img).resizeNearestNeighbor([224, 224]).toFloat().expandDims(0).div(255.0);
          const prediction = model.predict(tensor);
          // Handle potential array output from predict
          const outputTensor = Array.isArray(prediction) ? prediction[0] : prediction;
          const data = await outputTensor.data();
          const label = labels[data.indexOf(Math.max(...data))];
          if (['porn', 'sexy', 'hentai'].includes(label)) {
            console.log('NSFW content detected:', label, img.src);
            // Hide the image or take any other action
            img.style.display = 'none';
          } else {
            console.log('Safe content:', label, img.src);
          }
          tensor.dispose(); // Dispose of the tensor to free memory
        } catch (error) {
          console.error('Error classifying image:', error);
        }
      }

      const classifyAllImages = () => {
        const images = Array.from(document.querySelectorAll('img'));
        console.log('Found images:', images.map(img => img.src));
        images.forEach((img) => {
          if (img.complete) {
            classifyImage(img as HTMLImageElement);
          } else {
            img.addEventListener('load', () => classifyImage(img as HTMLImageElement));
          }
        });
      };
      classifyAllImages();

      // // Scrape all images on the page
      // const images = Array.from(document.querySelectorAll('img'));
      // console.log('Found images:', images.map(img => img.src));

      // Set up a MutationObserver to watch for new/changed images
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.type === 'childList') {
            mutation.addedNodes.forEach(node => {
              if (node.nodeType === 1 && (node as HTMLElement).tagName === 'IMG') {
                classifyImage(node as HTMLImageElement);
                console.log('New image added:', (node as HTMLImageElement).src);
              }
              // Also check for images inside added subtrees
              if (node.nodeType === 1) {
                (node as HTMLElement).querySelectorAll?.('img').forEach(img => {
                  classifyImage(img as HTMLImageElement);
                  console.log('New image in subtree:', (img as HTMLImageElement).src);
                });
              }
            });
          }
          if (mutation.type === 'attributes' && mutation.target instanceof HTMLImageElement && mutation.attributeName === 'src') {
            classifyImage(mutation.target as HTMLImageElement);
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
    world: 'MAIN',
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
