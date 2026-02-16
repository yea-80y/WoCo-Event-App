<script lang="ts">
  import type { OrderField } from "@woco/shared";
  import ImageUpload from "./ImageUpload.svelte";
  import TicketSeriesEditor from "./TicketSeriesEditor.svelte";
  import OrderFieldsEditor from "./OrderFieldsEditor.svelte";
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
  let collectInfo = $state(false);
  let orderFields = $state<OrderField[]>([]);
</script>

<div class="event-form">
  <h2>Create Event</h2>

  <ImageUpload bind:imageDataUrl onchange={(url) => imageDataUrl = url} />

  <div class="fields">
    <label>
      <span>Event title</span>
      <input type="text" bind:value={title} placeholder="My awesome event" />
    </label>

    <label>
      <span>Description</span>
      <textarea bind:value={description} placeholder="Tell people about your event" rows="3"></textarea>
    </label>

    <div class="row">
      <label>
        <span>Start date</span>
        <input type="datetime-local" bind:value={startDate} />
      </label>
      <label>
        <span>End date</span>
        <input type="datetime-local" bind:value={endDate} />
      </label>
    </div>

    <label>
      <span>Location</span>
      <input type="text" bind:value={location} placeholder="Venue or online link" />
    </label>
  </div>

  <TicketSeriesEditor bind:series />

  <OrderFieldsEditor bind:orderFields bind:enabled={collectInfo} />

  <PublishButton
    {title}
    {description}
    {startDate}
    {endDate}
    {location}
    {imageDataUrl}
    {series}
    orderFields={collectInfo ? orderFields : undefined}
    {onpublished}
  />
</div>

<style>
  .event-form {
    display: flex;
    flex-direction: column;
    gap: 1.75rem;
    max-width: 560px;
    margin: 0 auto;
  }

  h2 {
    color: var(--text);
    margin: 0;
    font-size: 1.5rem;
    font-weight: 700;
    letter-spacing: -0.01em;
  }

  .fields {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
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
</style>
