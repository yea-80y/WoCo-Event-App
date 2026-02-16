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
    <button class="upload-area" onclick={() => document.getElementById('img-input')?.click()}>
      <span class="upload-icon">+</span>
      <span class="upload-text">Add event image</span>
    </button>
  {/if}
  <input id="img-input" type="file" accept="image/*" onchange={handleFile} hidden />
</div>

<style>
  .image-upload {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
  }

  .preview {
    width: 100%;
    max-height: 220px;
    object-fit: cover;
    border-radius: var(--radius-md);
    border: 1px solid var(--border);
  }

  .upload-area {
    width: 100%;
    padding: 2.5rem 1rem;
    border: 2px dashed var(--border);
    border-radius: var(--radius-md);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    transition: border-color var(--transition), background var(--transition);
  }

  .upload-area:hover {
    border-color: var(--accent);
    background: var(--accent-subtle);
  }

  .upload-icon {
    font-size: 1.5rem;
    color: var(--text-muted);
    font-weight: 300;
  }

  .upload-text {
    color: var(--text-muted);
    font-size: 0.875rem;
  }

  .upload-area:hover .upload-icon,
  .upload-area:hover .upload-text {
    color: var(--accent-text);
  }

  .change-btn {
    padding: 0.375rem 0.875rem;
    font-size: 0.8125rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    transition: all var(--transition);
  }

  .change-btn:hover {
    border-color: var(--accent);
    color: var(--accent-text);
  }
</style>
