import { mount } from 'svelte'
import './multi-site.css'
import MultiSiteApp from './MultiSiteApp.svelte'

const app = mount(MultiSiteApp, {
  target: document.getElementById('app')!,
})

export default app
