# Portfolio experience V1

This is the product-design specification for the portfolio. Redesign v2 (October 2026) is the current visual direction and is implemented in the working tree. The implemented system is described in [system design](../system-design.md). Phase 1 stays open on the [roadmap](../roadmap.md).

The specification uses the approved public documents already in `content/public`. It does not add career claims. Sections that need material the corpus does not yet contain stay empty until that material is reviewed.

## Audience

- Hiring managers who want evidence of ownership, scope, and judgment.
- Recruiters who need a fast read on fit.
- Engineers evaluating technical depth.
- People arriving from a resume, LinkedIn, an application, or a direct link.

## Visitor goals

A visitor should quickly understand:

- Who Lucas is, from the approved profile.
- What kind of engineer he is, from the profile headline, topics, and skills.
- What he currently builds, from the experience document referenced by `current_role`.
- The scale and type of problems he has worked on, only where an approved public document already says so.
- His progression into software engineering, from the experience and education documents.
- How to open a deeper page section.
- How to ask a career question about that reviewed record.

## Overall character

The site should feel technically credible, calm, and personal. It is content-first and reads like an engineer's own record, not a template.

The first visual direction (warm cream canvas, dark navy hero, Manrope with IBM Plex Mono labels, an impact strip of stat tiles, and card lists) was replaced by redesign v2 in October 2026. In review it read as templated: the all-caps eyebrow labels, monospace metadata, middle-dot separators, em-dash titles, arrow labels, identical card grids, and the cream canvas are the patterns generic portfolio generators produce. Redesign v2 keeps the information and replaces the presentation with one signature idea: the career drawn as a capacity plan.

These are banned in v2:

- All-caps eyebrow labels.
- Monospace type anywhere.
- Middle-dot separators.
- Em-dash "A — B" titles.
- Arrows in labels or buttons.
- Identical card grids.
- The cream canvas.
- Fake terminals, typewriter effects, particle systems, WebGL scenes, animated counters, glassmorphism, and decorative motion.

The static mockups behind v2 were design-canvas exports kept outside this repository. They were reference only: the shipped pages are generated from content, not copied from their hand-positioned numbers.

## Color and theme

V2 is light, with a cool grey ground and ink-colored dark panels. There is no theme selector and no dark mode.

| Token               | Value     | Use                                                 |
| ------------------- | --------- | --------------------------------------------------- |
| Ground              | `#E8ECF0` | Page background                                     |
| Surface             | `#F5F7F9` | Chart boxes and the position strip                  |
| Ink                 | `#0F1B2D` | Headings, primary text, primary button              |
| Body                | `#3E4B5B` | Body copy                                           |
| Muted               | `#4A5868` | Secondary text, axis labels                         |
| Rule                | `#C9D1DA` | Row dividers, axis line                             |
| Track               | `#DCE2E8` | Bar tracks, lane dividers, the axis-break hatch     |
| AWS lane            | `#1F4E8C` | AWS bars, solid result bars, link hover, focus ring |
| Contract lane       | `#4F7BB5` | Contract bars                                       |
| Small business lane | `#5C6930` | Small-business bars                                 |
| Education lane      | `#6C7C90` | Education bars                                      |
| Range               | `#9DB3D1` | The lighter high end of a result range              |
| Context bar         | `#7D8A99` | Other roles on the position strip                   |
| Today               | `#E8590C` | The Today line only                                 |

Dark panels (the Ask box and the footer band) use background `#0F1B2D`, text `#E8ECF0`, secondary text `#B6C2CF`, dividers `#263B55`, and an input of `#172A42` with a `#34506F` border.

Contrast: body, muted, and panel text are at least 4.5:1 on their backgrounds. Chart bars are at least 3:1 against the surface. Two token adjustments make that true. The mockups' grey context bars (`#C9D1DA`, 1.4:1) became `#7D8A99` (3.3:1). The range color is under 3:1 on its track, so each range ends in a 2px AWS-blue cap that marks its high end. The mockups' `#6B7787` axis-break label (4.2:1) uses the muted token instead.

## Typography

One family: Archivo, self-hosted from `@fontsource-variable/archivo/wdth.css`, which carries both the weight axis (100–900) and the width axis (62–125%) under the OFL. Width is set with `font-stretch`:

| Role                   | Width / weight                    |
| ---------------------- | --------------------------------- |
| Logotype               | 125% / 700                        |
| h1                     | 112% / 650                        |
| h2                     | 108–110% / 640                    |
| h3                     | 105% / 640                        |
| Body                   | 100% / 400                        |
| Chart labels and dates | 78–85% / 500–600, tabular numbers |

Manrope and IBM Plex Mono are removed from the project.

## Frontend tools and constraints

Most of the portfolio is static content. React is used only where persistent client-side state is required, which is the assistant. That split is intentional.

- Astro remains responsible for static rendering, layouts, routing, and content pages.
- React is limited to the interactive assistant island.
- TypeScript remains the frontend language.
- Styling uses custom CSS, scoped component styles, and shared CSS custom-property design tokens.
- Tailwind, Bootstrap, Material UI, shadcn, and other large component systems stay out.
- Framer Motion and other general animation frameworks stay out.
- CSS transitions, and small Astro-native transitions, are used only where they improve orientation or feedback.
- `prefers-reduced-motion` is respected.
- Astro Assets handles local image optimization.
- A small consistent icon set such as Lucide may be added only when an actual interface need justifies it.
- Playwright is added during UI implementation for desktop and mobile browser behavior.
- Automated accessibility checks are added, and manual keyboard and focus verification stays.
- Vitest and Testing Library remain the tools for component behavior.

These choices are recorded here so implementation does not reopen them. They are not installed in this documentation slice.

## Approved layout

One assistant instance per page. It is not duplicated.

### Homepage

1. Header: the "Lucas Elia" logotype and navigation to Career, Results, Experience, and Ask. Contact joins the navigation once contact content is approved.
2. Hero: the headline, the introduction, and the actions "Ask about my work" (to `#ask`) and "See my career" (to `#career`). On desktop the assistant sits to the right. On phones it follows the introduction directly and the second action is hidden.
3. How I got here (`#career`), the career chart.
4. Experience.
5. Education.
6. Contact.
7. Footer: an ink band with the name and the current role.

The Overview section is removed. It repeated the hero and showed the raw profile headline.

### Narrow viewports

Everything is one column below 640px. The layout works down to 360px with no horizontal page scroll. Between 640px and about 980px the horizontal career chart scrolls inside its own box.

## Section content

### Hero

- Headline: `I build dependable backend systems for complex, high-stakes planning problems.`
- Introduction: `I’m Lucas Elia, a software engineer at AWS in Seattle. I work on backend systems for capacity planning.` It is also the homepage meta description and Open Graph description.
- Status line under the introduction, in muted body text: `This site is new and I’m building it in the open. More is on the way.`

### How I got here (the career chart)

The section heading is "How I got here" (approved October 13, 2026; it replaced "My career as a capacity plan"). The chart still draws the career as a capacity plan.

The signature component. Beside the heading is the reviewed About sentence, read from the profile body at build time: "My path into software wasn’t traditional. Before becoming an engineer, I owned and operated small businesses, then entered technology through an apprenticeship."

- The chart is built from the content collection by `apps/web/src/career-chart.ts`. Each experience and education document gives one bar from `start_date` to `end_date`. A null end date runs to Today, the build date.
- Lanes: an AWS employer is AWS, `employment_type: Contract` is Contract, `Self-employed` is Small business, and every education document is Education. Lanes appear in that order. An experience that maps to no lane fails the build instead of disappearing.
- The time axis is a two-segment piecewise scale. The largest gap in coverage, when it is at least three years, becomes a hatched 4% break. The early segment takes 34% of the width and the recent one 62%. Segment bounds round outward to half years, so the current corpus gives 2006 to mid-2014, a "2015–2020" break, and mid-2021 to the start of the year after the build. Ticks step every one, two, or five years, whichever leaves room, and year ticks beside the break are dropped.
- Bars are links to the role page, with an accessible name of role, employer, and dates, and a visible focus ring. A short label sits under each bar: titles that share leading words in one lane keep only the last shared word ("Engineer II"), followed by years. Overlapping labels drop to another row, and a label that would run past the right edge is right-aligned to its bar.
- The orange Today line spans every lane. The caption reads "Each bar opens that role. The axis skips 2015 to 2020 to give recent roles more room."
- Below 640px the same data is drawn vertically: Today at the top, lanes as narrow columns, labels to the right, and a lane legend.
- Lumen Harbor and anything outside the reviewed public record never appear.

### What changed (removed)

The What changed section was removed on October 13, 2026, after a line-by-line copy review. The chart flows straight into Experience, and there is no Results navigation item.

### Experience and Education

Full-width rows, not cards. A dates column with condensed tabular dates ("Dec 2025 to now") and the employment type on its own line, then the role link, employer, and location, then the summary. Several employers stored with `|` render as prose: "Bloom Coffee & Tea, Pause Lounge & Kitchen, and Broadacre Coffee". Education rows show the program link, institution, summary, and a plain status line such as "Completed. No degree awarded."

### Selected projects and work

The portfolio application is still intended to become the first approved public project and case study after deployment. It is planned content, not part of `content/public`. No selected-work section is shown until a reviewed project document exists.

### Contact and footer

Contact content was approved on October 13, 2026: `email`, `linkedin_url`, and `github_url` in the profile front matter, validated as an email and https URLs. The Contact section is the dark ink band from the mockup: "Contact", the line "The best way to reach me is email. I’m also on LinkedIn and GitHub.", and links for Email (mailto, primary), LinkedIn, and GitHub (secondary, `rel="noopener"`). Contact is in the navigation, after Career and Experience. These fields are not in the career index, the retrieval Facts header, or the evidence package. A résumé link is still unresolved. The footer shows the name and the current role.

### v1 static site (no assistant)

The production build (`pnpm build:site`, [ADR-007](../adr/007-static-site-hosting.md)) renders no assistant at all when `PUBLIC_ASK_API_URL` is unset: no panel, no role-page box, no Ask nav item, and no "Ask about my work" button, and no unavailable state or teaser. The hero becomes one deliberate column: the headline at a reading measure, the introduction, then "See my career" (primary) and "Contact" (secondary). The production build also omits the fictional fixture and the career index, and adds canonical URLs, Open Graph tags, `robots.txt`, a sitemap, an LE monogram favicon, and a 404 page in the site's style.

## Role and detail pages

Experience and education pages follow `role-page-desktop.html`:

- A back link ("All experience" or "All education"), a large h1, and the meta as plain lines ("Amazon Web Services, Seattle, WA" / "December 2025 to now, full-time").
- A position strip: the same chart scale with every other bar in the context grey, this role in its lane color, and the Today line.
- The summary as a lead paragraph. The role's bullets under "What I work on" for the current role or "What I worked on" for past roles. That heading keeps the citation anchor of the source H2, so `#role-description` and the other anchors still resolve. A bullet or paragraph that repeats the summary is not shown twice. A "Primary technologies:" line becomes a Technologies sentence. A body that uses other Markdown falls back to the regular renderer.
- Earlier and later role links.
- The Type, Visibility, and Last reviewed rows are removed from visitor pages.
- The Ask box is the same React island in a compact variant, with role-specific suggested questions from `apps/web/src/ask-suggestions.ts`. The fictional fixture page has no Ask box and no position strip.

## Assistant experience

The assistant is an evidence-backed way to explore the reviewed career. Its behavior is unchanged by v2; only its presentation changed.

- Heading "Ask about my work" ("Ask about this role" on role pages). No eyebrow label.
- The line "Answers come from my reviewed career pages, and each one links to its source." on the homepage.
- Suggested questions as a divided list of buttons, in second person: "What have you built at AWS?", "How have you improved production reliability?", "What distributed-systems work have you done?", "How did you move into software engineering?". They appear before the first exchange only. With the default deterministic API, the reliability question and most role-page questions return the unsupported sentence; they are answered in model mode.
- A visible "Your question" label on the textarea. Enter sends and Shift+Enter inserts a line break. The field's id stays `question`.
- A disabled Send button is drawn as an outlined, quieter button so it reads as waiting for a question rather than broken.
- Answers, citations, loading, unsupported, timeout, unavailable, validation, malformed-response, interrupted-stream, and citation-rejected states are unchanged. Citations link only to the allowlisted routes.
- With `PUBLIC_ASK_STREAMING=true` and a local model or fixture server, answer text streams. Production streaming is still Slice 2.
- The page does not persist the conversation or record questions.
- The copy does not say or imply access to private AWS systems or private career notes.

## Fictional fixture

`content/public/fictional-lumen-harbor.md` remains available for validation and route tests. It does not appear in the primary homepage experience. It is not presented as Lucas’s work. It stays excluded from assistant retrieval.

## Accessibility

- Semantic landmarks for the header, main career content, assistant, and footer.
- One logical heading hierarchy. The page has one `h1`.
- Visible focus states on links, buttons, and the question field.
- The question field has an associated label. The implemented composer uses a visually hidden label so the control stays compact.
- The assistant works from the keyboard alone.
- Text and controls meet contrast expectations on both the warm page and the dark navy surfaces.
- Reduced-motion support for any transition. The page remains usable with motion reduced.
- Loading, success, and error states are announced to assistive technology.
- Status is not conveyed by color alone.

## Performance

- Astro static output remains the default.
- React stays limited to the interactive assistant island.
- The portfolio body is not converted to a client-side application.
- Self-hosted WOFF2 files and Astro Assets keep font and image payloads small. A headshot is omitted until that decision adds an approved asset.
- The static page still renders when the ask API or JavaScript is unavailable.
- Assistant JavaScript does not block the static career content.

## Privacy and safety

- Only reviewed public content is rendered or retrieved.
- The page and the assistant have no access to private career notes.
- Copy does not add proprietary AWS material beyond the approved public documents.
- Visitor questions are not persisted.
- Request bodies are not logged by the page.
- Citation URLs remain on the allowlisted site routes.

## Redesign v2 implementation

Redesign v2 is implemented and live on the static site, without the assistant. It covers the shared visual system, the homepage sections above, the role and education pages, the profile page, and the compact assistant. Playwright and axe cover desktop, phone, and 360px widths, chart links and focus, the hero action, the unconfigured assistant, anchors, the role page, the fictional fixture, and reduced motion. Unit tests cover the scale function, lane mapping, today position, label layout, and the role-body parser.

Phase 1 stays open: the headshot and case-study diagrams are unresolved. Contact content is approved and shipped.

## Remaining unresolved product decisions

These are the product questions still open for V1:

- Whether to include Lucas’s professional headshot in the hero.
- A reviewed résumé link. Email, LinkedIn, and GitHub were approved on October 13, 2026.
- Whether case-study architecture diagrams are introduced in V1 or afterward.

Hosting, domain, production CORS, deployment identities, and budget destinations are deployment decisions. They stay in the [roadmap](../roadmap.md) and [deployment readiness](../deployment-readiness.md).

## Acceptance criteria

Approve the remaining product design before implementation when every item below is true:

- The homepage is the seven-part v2 layout above, with the assistant in the hero.
- Mobile places the introduction first and the same assistant directly under it.
- The career chart and position strip are generated from front matter, with no hand-positioned bars.
- None of the banned v2 patterns appear.
- Lumen Harbor is absent from the primary homepage and from assistant retrieval.
- The portfolio case study is described as future content and is not added to the corpus yet.
- Hero copy, action labels, headshot, and contact destinations are either approved or still explicitly unresolved.
- Suggested-question themes are visible before the first message.
- Index answers and model answers share one visual result pattern inside the assistant surface.
- Loading, unsupported, timeout, unavailable, validation, malformed-response, interrupted-stream, retry, and citation-safety states are specified.
- Keyboard, focus, labels, contrast, reduced motion, and status announcements are required.
- The static portfolio remains readable when JavaScript or the API is unavailable.
- The design does not request accounts, saved transcripts, question analytics, a theme selector, or job comparison.
- Real streaming is implemented for the opt-in local server. The default page does not stream and does not imitate streaming. Production streaming is still Slice 2. Live Nova evaluation has not been run.
