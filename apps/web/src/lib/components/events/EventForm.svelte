<script lang="ts">
  import ImageUpload from "./ImageUpload.svelte";
  import TicketSeriesEditor from "./TicketSeriesEditor.svelte";
  import PublishButton from "./PublishButton.svelte";

  interface Props {
    onpublished?: (eventId: string) => void;
  }

  let { onpublished }: Props = $props();

  let title = $state("");
  let description = $state("");
  let startDate = $state("");
  let endDate = $state("");
  let location = $state("");
  let imageDataUrl = $state<string | null>(null);
  let series = $state([
    {
      seriesId: crypto.randomUUID(),
      name: "",
      description: "",
      totalSupply: 10,
    },
  ]);
</script>

<div class="event-form">
  <h2>Create Event</h2>

  <ImageUpload bind:imageDataUrl onchange={(url) => imageDataUrl = url} />

  <div class="fields">
    <label>
      <span>Event title *</span>
      <input type="text" bind:value={title} placeholder="My awesome event" />
    </label>

    <label>
      <span>Description</span>
      <textarea bind:value={description} placeholder="Tell people about your event" rows="3"></textarea>
    </label>

    <div class="row">
      <label>
        <span>Start date *</span>
        <input type="datetime-local" bind:value={startDate} />
      </label>
      <label>
        <span>End date *</span>
        <input type="datetime-local" bind:value={endDate} />
      </label>
    </div>

    <label>
      <span>Location</span>
      <input type="text" bind:value={location} placeholder="Venue or online link" />
    </label>
  </div>

  <TicketSeriesEditor bind:series />

  <PublishButton
    {title}
    {description}
    {startDate}
    {endDate}
    {location}
    {imageDataUrl}
    {series}
    {onpublished}
  />
</div>

<style>
  .event-form {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    max-width: 560px;
    margin: 0 auto;
  }

  h2 {
    color: #e2e8f0;
    margin: 0;
  }

  .fields {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  label span {
    color: #9ca3af;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  input, textarea {
    padding: 0.5rem 0.75rem;
    border: 1px solid #374151;
    border-radius: 6px;
    background: #0f0f23;
    color: #e2e8f0;
    font-size: 0.875rem;
    font-family: inherit;
  }

  input:focus, textarea:focus {
    outline: none;
    border-color: #4f46e5;
  }

  textarea {
    resize: vertical;
  }
</style>
