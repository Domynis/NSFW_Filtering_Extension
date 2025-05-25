<script setup lang="ts">
import { ref, onMounted } from 'vue';

const isFilterActive = ref(false);
const isLoading = ref(true);

// Function to get initial state from storage
const syncState = async () => {
  isLoading.value = true;
  try {
    const data = await chrome.storage.local.get('isFilterActive');
    isFilterActive.value = !!data.isFilterActive; // Default to false if undefined
  } catch (error) {
    console.error("Error getting filter state:", error);
    isFilterActive.value = false; // Assume inactive on error
  } finally {
    isLoading.value = false;
  }
};

// Function to toggle the state via background script
const toggleFilter = () => {
  const newState = !isFilterActive.value;
  isLoading.value = true; // Show loading until state confirmed
  chrome.runtime.sendMessage({ type: 'TOGGLE_FILTER', active: newState }, (response) => {
    if (chrome.runtime.lastError) {
      console.error("Error sending toggle message:", chrome.runtime.lastError.message);
      // Revert UI optimistic update or show error
      isLoading.value = false;
      // Optionally call syncState again to be sure
      syncState();
      return;
    }
    if (response?.status === 'success') {
      console.log('Toggle message acknowledged by background.');
      // Background script should update storage, rely on listener or syncState for UI update
      // isFilterActive.value = newState; // Optimistic update (optional)
    } else {
      console.error("Background script failed to toggle state.");
      // Revert UI or show error
    }
    // Let the storage listener update the UI state definitively
    // isLoading.value = false; // Handled by storage listener ideally
  });
};

// Listen for state changes from background/storage
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local' && changes.isFilterActive) {
    console.log('Popup received storage change:', changes.isFilterActive.newValue);
    isFilterActive.value = !!changes.isFilterActive.newValue;
    isLoading.value = false; // State confirmed
  }
});

// Get initial state when popup opens
onMounted(syncState);

</script>

<template>
  <div class="popup-container">
    <header class="popup-header">
      <h1>NSFW Filter</h1>
    </header>
    <div class="content-area">
      <div class="status-section">
        <p class="status-text">
          Status:
          <span v-if="isLoading" class="loading-text">Loading...</span>
          <span v-else :class="['status-indicator', isFilterActive ? 'active' : 'inactive']">
            {{ isFilterActive ? 'Active' : 'Inactive' }}
          </span>
        </p>
      </div>
      <button type="button" @click="toggleFilter" :disabled="isLoading"
        :class="['toggle-button', isFilterActive ? 'active-button' : 'inactive-button']">
        <span v-if="isLoading">Please wait...</span>
        <span v-else>{{ isFilterActive ? 'Deactivate Filter' : 'Activate Filter' }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.popup-container {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  padding: 0;
  min-width: 280px;
  text-align: center;
  background-color: #f9f9f9;
  color: #333;
  border-radius: 10px;
  box-shadow: 0 5px 15px rgba(0, 0, 0, 0.12);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.popup-header {
  background-color: #0066CC;
  padding: 20px 18px;
}

h1 {
  font-size: 2.2em;
  color: #ffffff;
  margin-top: 0;
  margin-bottom: 0;
  font-weight: 600;
  letter-spacing: 0.5px;
}

.content-area {
  padding: 20px 18px;
}

.status-section {
  margin-bottom: 25px;
}

.status-text {
  font-size: 1em;
  color: #555;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 28px;
}

.loading-text {
  font-style: italic;
  color: #0066CC;
}

.status-indicator {
  font-weight: bold;
  padding: 5px 12px;
  border-radius: 16px;
  margin-left: 8px;
  font-size: 0.9em;
  line-height: 1.2;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

.status-indicator.active {
  background-color: #28a745;
  color: white;
}

.status-indicator.inactive {
  background-color: #dc3545;
  color: white;
}

.toggle-button {
  color: white;
  border: none;
  padding: 12px 20px;
  font-size: 1em;
  font-weight: 500;
  border-radius: 6px;
  cursor: pointer;
  transition: background-color 0.2s ease-in-out, transform 0.1s ease, box-shadow 0.2s ease;
  width: 100%;
  box-sizing: border-box;
  box-shadow: 0 2px 5px rgba(0, 0, 0, 0.15);
}

.toggle-button:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
}

.toggle-button:active:not(:disabled) {
  transform: translateY(0px);
  box-shadow: 0 2px 5px rgba(0, 0, 0, 0.15);
}

.toggle-button.inactive-button {
  background-color: #0066CC;
}

.toggle-button.inactive-button:hover:not(:disabled) {
  background-color: #0052a3;
}

.toggle-button.active-button {
  background-color: #dc3545;
}

.toggle-button.active-button:hover:not(:disabled) {
  background-color: #c82333;
}

.toggle-button:disabled {
  background-color: #cccccc;
  color: #666666;
  cursor: not-allowed;
  opacity: 0.7;
  box-shadow: none;
}
</style>