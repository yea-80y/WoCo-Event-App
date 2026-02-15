<script lang="ts">
  interface Props {
    imageDataUrl: string | null;
    onchange: (dataUrl: string) => void;
  }

  let { imageDataUrl = $bindable(), onchange }: Props = $props();

  function handleFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      imageDataUrl = result;
      onchange(result);
    };
    reader.readAsDataURL(file);
  }
</script>

<div class="image-upload">
  {#if imageDataUrl}
    <img src={imageDataUrl} alt="Event preview" class="preview" />
    <button class="change-btn" onclick={() => document.getElementById('img-input')?.click()}>
      Change image
    </button>
  {:else}
    <button class="upload-btn" onclick={() => document.getElementById('img-input')?.click()}>
      Upload event image
    </button>
  {/if}
  <input id="img-input" type="file" accept="image/*" onchange={handleFile} hidden />
</div>

<style>
  .image-upload {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
  }

  .preview {
    width: 100%;
    max-height: 200px;
    object-fit: cover;
    border-radius: 8px;
    border: 1px solid #2a2a4a;
  }

  .upload-btn {
    width: 100%;
    padding: 2rem;
    border: 2px dashed #374151;
    border-radius: 8px;
    background: transparent;
    color: #9ca3af;
    cursor: pointer;
    font-size: 0.875rem;
  }

  .upload-btn:hover {
    border-color: #4f46e5;
    color: #818cf8;
  }

  .change-btn {
    padding: 0.375rem 0.75rem;
    font-size: 0.8125rem;
    border: 1px solid #374151;
    border-radius: 6px;
    background: transparent;
    color: #9ca3af;
    cursor: pointer;
  }

  .change-btn:hover {
    border-color: #4f46e5;
    color: #818cf8;
  }
</style>
