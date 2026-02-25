import { mount } from 'svelte'
import './app.css'
import SiteApp from './SiteApp.svelte'

const app = mount(SiteApp, {
  target: document.getElementById('app')!,
})

export default app
