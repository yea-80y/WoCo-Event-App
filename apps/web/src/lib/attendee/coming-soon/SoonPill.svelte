<span class="soon-pill" aria-hidden="true">
  <span class="prefix">//</span><span class="word">SOON</span>
</span>

<style>
  .soon-pill {
    position: absolute;
    top: -4px;
    right: -10px;
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 2px 5px 1px 4px;
    background: var(--accent-ink);
    border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
    border-radius: var(--radius-sm);
    transform: rotate(-4deg);
    transform-origin: 100% 50%;
    /* reads as sticker on top of the icon, not fused to it */
    outline: 2px solid var(--bg-elevated);
    pointer-events: none;
    z-index: 10;
  }
  .prefix {
    font-family: var(--font-mono);
    font-size: 9px;
    color: var(--text-muted);
    line-height: 1;
    letter-spacing: 0;
  }
  .word {
    font-family: var(--font-tag);
    font-size: 9px;
    color: var(--accent);
    letter-spacing: 0.08em;
    line-height: 1;
  }
</style>
