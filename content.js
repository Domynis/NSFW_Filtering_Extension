let model;

// Define the label set in the same order as your training data
const labels = ['drawing', 'hentai', 'neutral', 'porn', 'sexy'];

// Load the model
async function loadModel() {
  model = await tf.loadLayersModel(chrome.runtime.getURL('model_tfjs/model.json'));
  console.log("Model loaded.");
  classifyImages();
}

// Preprocess image: convert to tensor, resize, normalize, etc.
async function preprocessImage(img) {
  const tensor = tf.browser.fromPixels(img)
    .resizeNearestNeighbor([224, 224]) // Adjust to your model’s input size
    .toFloat()
    .div(255.0); // Normalize to [0,1] range if needed
  return tensor;
}

// Check if the predicted label should be blocked
function shouldBlock(label) {
  // Customize this logic as needed
  return label === "porn" || label === "sexy" || label === "hentai";
}

// Classify all images on the page
async function classifyImages() {
  const images = document.querySelectorAll("img");

  for (const img of images) {
    try {
      const tensor = await preprocessImage(img);
      const prediction = model.predict(tensor.expandDims(0));
      const predData = await prediction.data();

      const labelIndex = predData.indexOf(Math.max(...predData));
      const label = labels[labelIndex];

      if (shouldBlock(label)) {
        img.style.filter = "blur(20px)";
        img.title = `Blocked: ${label}`;
      }

      tensor.dispose();
      prediction.dispose();
    } catch (err) {
      console.error("Error classifying image", err);
    }
  }
}

loadModel();