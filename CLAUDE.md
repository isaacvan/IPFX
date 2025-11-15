# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

IPFX is a static website for a proprietary trading firm (ipfxcapital.com). The site is a single-page application built with vanilla HTML, CSS, and JavaScript, hosted via GitHub Pages. It features a modern, dark-themed UI with custom animations and interactive components.

## Architecture

### File Structure
- **index.html**: Main landing page with all sections (hero, features, pricing, testimonials, FAQ)
- **Secondary pages**: about.html, contact.html, faq.html, infinity.html, login.html, personalised-challenge.html, trading-pot.html (all currently "under construction" templates)
- **assets/images/**: Favicon and branding assets
- **assets/js/**: Currently empty (all JavaScript is inline in HTML)

### Design System
The site uses a comprehensive CSS custom properties system defined in `:root`:
- Color palette: `--bg`, `--fg`, `--muted`, `--line`, `--silver`, `--forest`, `--mint`
- Typography scale: `--h1`, `--h2`, `--h3`, `--lead` (all use clamp() for responsive sizing)
- Spacing: `--section-gap`, `--container-w`
- Visual: `--radius`, `--shadow`

Primary brand colors:
- Background: `#0a0a0c`
- Accent blue: `#2563eb` (cobalt blue)
- Deep blue: `#1e3a8a`

### Key Interactive Components

All JavaScript is inline within `<script>` tags in index.html:

1. **Flicker Animation** (line ~1557): Text elements with `.flicker-word` class randomly flicker to simulate a glitch effect. Respects `prefers-reduced-motion`.

2. **Typewriter Effect** (line ~1604): Elements with `.af-typewriter` class cycle through phrases defined in `data-phrases` attribute (pipe-separated).

3. **Pricing Calculator** (line ~2140): Interactive balance selector that updates daily/total loss limits and profit targets based on account size ($10k-$200k). Terms object defines all values.

4. **Canvas Flow Lines** (line ~2560): Full-width canvas animation (`#flowLines`) rendering animated flowing lines with professional blue palette. Includes DPR scaling, resize observer, and performance optimizations.

5. **Testimonials Carousel** (line ~2755): Full-featured carousel with drag/swipe support, dot navigation, and prev/next buttons. Includes momentum detection and touch event handling.

6. **Reveal Animations** (line ~2175): Intersection Observer-based scroll animations for `.reveal` and `.arrow-down` elements.

7. **Count-up Animation** (line ~2214): Numeric values with `.countup` class animate from 0 to target value on scroll into view. Supports $, hrs, and min suffixes.

8. **Card Hover Typewriter** (line ~2240): Feature cards display descriptions via typewriter effect when hovered.

## Development Commands

This is a static site with no build process. Development workflow:

```bash
# Serve locally (use any static server)
npx serve .
# or
python -m http.server 8000

# The site can be opened directly in a browser
open index.html
```

## Deployment

The site is deployed via GitHub Pages. Changes to the `main` branch automatically deploy to ipfxcapital.com (configured via CNAME).

```bash
# Standard git workflow
git add .
git commit -m "description"
git push origin main
```

## Code Conventions

1. **All styles are inline**: No external CSS files. Styles are defined in `<style>` tags within each HTML file.

2. **All JavaScript is inline**: No external JS files. All interactivity is implemented in `<script>` tags within index.html.

3. **Responsive design**: Heavy use of `clamp()` for fluid typography and `min()` for container widths. Mobile-first breakpoints via media queries.

4. **Accessibility**:
   - Respects `prefers-reduced-motion` for animations
   - Semantic HTML structure
   - ARIA attributes where appropriate

5. **Performance optimizations**:
   - Canvas DPR scaling capped at 2x
   - Animation frame management with proper cleanup
   - Intersection Observer for lazy reveal animations
   - ResizeObserver for efficient canvas resizing

## Common Patterns

### Adding a new animated section
1. Wrap content in a container with `.reveal` class
2. Add `opacity: 0; transform: translateY(20px); transition: ...` in CSS
3. Add `.reveal.is-visible` styles for revealed state
4. IntersectionObserver automatically handles the animation trigger

### Modifying pricing tiers
Update the `terms` object (line ~2142) with new account sizes and corresponding limits. Format:
```javascript
{
  accountSize: {
    daily: dailyLossLimit,
    total: totalLossLimit,
    target1: profitTarget1,
    target2: profitTarget2
  }
}
```

### Canvas performance tuning
Key variables in flow lines animation (line ~2609):
- `maxCountBase`: Base number of flow lines (default: 24)
- `baseSpeed`: Animation speed (20 normal, 8 reduced motion)
- Line count scales with viewport area but caps at 32

## Testing

Since this is a marketing site with no backend:
1. Test across browsers (Chrome, Firefox, Safari, Edge)
2. Test responsive breakpoints (mobile, tablet, desktop)
3. Test animations with reduced motion preferences
4. Verify touch interactions on mobile devices
5. Test canvas performance on lower-end devices
- can you ensure that all the elements have that same fade into view effect that we had for the top things