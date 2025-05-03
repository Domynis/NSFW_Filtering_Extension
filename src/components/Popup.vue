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
  <h1>NSFW Filter</h1>
  <div class="card">
    <p>Filter Status: {{ isLoading ? 'Loading...' : (isFilterActive ? 'Active' : 'Inactive') }}</p>
    <button type="button" @click="toggleFilter" :disabled="isLoading">
      {{ isFilterActive ? 'Deactivate Filter' : 'Activate Filter' }}
    </button>
  </div>
</template>

<style scoped>
.card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>