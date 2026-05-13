<script lang="ts">
  import type { OrderField, OrderFieldType } from "@woco/shared";

  interface Props {
    orderFields: OrderField[];
    enabled: boolean;
  }

  let { orderFields = $bindable(), enabled = $bindable() }: Props = $props();

  const FIELD_TYPES: { value: OrderFieldType; label: string }[] = [
    { value: "text", label: "Text" },
    { value: "email", label: "Email" },
    { value: "tel", label: "Phone" },
    { value: "textarea", label: "Long text" },
    { value: "select", label: "Dropdown" },
    { value: "checkbox", label: "Checkbox" },
  ];

  function addField() {
    orderFields = [
      ...orderFields,
      {
        id: `field_${Date.now()}`,
        type: "text",
        label: "",
        required: false,
      },
    ];
  }

  function removeField(index: number) {
    orderFields = orderFields.filter((_, i) => i !== index);
  }

  function updateOptionsText(index: number, text: string) {
    const updated = [...orderFields];
    updated[index] = {
      ...updated[index],
      options: text.split(",").map((o) => o.trim()).filter(Boolean),
    };
    orderFields = updated;
  }

  function getOptionsText(field: OrderField): string {
    return field.options?.join(", ") ?? "";
  }
</script>

<div class="order-fields">
  <label class="toggle-row">
    <input type="checkbox" bind:checked={enabled} />
    <span>Collect attendee information</span>
  </label>

  {#if enabled}
    <p class="hint">
      Configure the fields shown to attendees when they claim a ticket.
      Their responses are encrypted — only you can read them.
    </p>

    {#each orderFields as field, i}
      <div class="field-card">
        <div class="field-header">
          <span class="field-num">Field {i + 1}</span>
          <button class="remove-btn" onclick={() => removeField(i)}>Remove</button>
        </div>

        <div class="field-row">
          <label class="field-label">
            <span>Label</span>
            <input
              type="text"
              bind:value={field.label}
              placeholder="e.g. Full Name"
            />
          </label>

          <label class="field-type">
            <span>Type</span>
            <select bind:value={field.type}>
              {#each FIELD_TYPES as ft}
                <option value={ft.value}>{ft.label}</option>
              {/each}
            </select>
          </label>
        </div>

        {#if field.type === "select"}
          <label>
            <span>Options (comma-separated)</span>
            <input
              type="text"
              value={getOptionsText(field)}
              oninput={(e) => updateOptionsText(i, (e.target as HTMLInputElement).value)}
              placeholder="e.g. None, Vegetarian, Vegan"
            />
          </label>
        {/if}

        <label class="toggle-row compact">
          <input type="checkbox" bind:checked={field.required} />
          <span>Required</span>
        </label>
      </div>
    {/each}

    <button class="add-btn" onclick={addField}>
      + Add field
    </button>
  {/if}
</div>

<style>
  .order-fields {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .hint {
    color: var(--text-muted);
    font-size: 0.8125rem;
    margin: 0;
    line-height: 1.4;
  }

  .toggle-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
  }

  .toggle-row span {
    color: var(--text-secondary);
    font-size: 0.875rem;
    font-weight: 500;
  }

  .toggle-row.compact {
    margin-top: -0.25rem;
  }

  .toggle-row.compact span {
    font-size: 0.8125rem;
    font-weight: 400;
  }

  .toggle-row input[type="checkbox"] {
    width: 1rem;
    height: 1rem;
    accent-color: var(--accent);
  }

  .field-card {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0.875rem;
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
  }

  .field-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .field-num {
    color: var(--text-muted);
    font-size: 0.8125rem;
    font-weight: 500;
  }

  .remove-btn {
    color: var(--text-muted);
    font-size: 0.8125rem;
    transition: color var(--transition);
  }

  .remove-btn:hover {
    color: var(--error);
  }

  .field-row {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0.75rem;
  }

  .field-label {
    min-width: 0;
  }

  .field-type {
    min-width: 120px;
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  label span {
    color: var(--text-secondary);
    font-size: 0.8125rem;
    font-weight: 500;
  }

  select {
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    padding: 0.5rem 0.625rem;
    font-size: 0.875rem;
    transition: border-color var(--transition);
  }

  select:focus {
    border-color: var(--accent);
    outline: none;
    box-shadow: 0 0 0 2px var(--accent-subtle);
  }

  .add-btn {
    padding: 0.5rem;
    border: 1px dashed var(--border);
    border-radius: var(--radius-sm);
    color: var(--accent-text);
    font-size: 0.8125rem;
    transition: all var(--transition);
  }

  .add-btn:hover {
    border-color: var(--accent);
    background: var(--accent-subtle);
  }
</style>
