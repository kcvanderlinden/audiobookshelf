const { createHash } = require('crypto')
const { LRUCache } = require('lru-cache')
const Database = require('../Database')
const podcastUtils = require('./podcastUtils')
const podcastFilters = require('./queries/libraryItemsPodcastFilters')

// Cache only feed data, never permission-filtered results or download state.
const feeds = new LRUCache({ max: 100, ttl: 5 * 60 * 1000 })

async function getFeed(url) {
  if (!feeds.has(url)) {
    const request = podcastUtils.getPodcastFeed(url, false, 15000).catch(() => null)
    feeds.set(url, request)
  }
  return feeds.get(url)
}

module.exports = async function getRecentPodcastEpisodes(user, library, limit, offset) {
  const permissions = podcastFilters.getUserPermissionPodcastWhereQuery(user)
  const podcasts = await Database.podcastModel.findAll({
    where: permissions.podcastWhere,
    replacements: permissions.replacements,
    include: [
      { model: Database.libraryItemModel, required: true, where: { libraryId: library.id } },
      {
        model: Database.podcastEpisodeModel,
        include: { model: Database.mediaProgressModel, required: false, where: { userId: user.id } }
      }
    ]
  })

  const episodes = []
  const failedFeeds = []
  let next = 0
  // Bound concurrent requests when a library contains many subscriptions.
  await Promise.all(Array.from({ length: Math.min(4, podcasts.length) }, async () => {
    while (next < podcasts.length) {
      const podcast = podcasts[next++]
      const item = podcast.libraryItem
      const localEpisodes = podcast.podcastEpisodes || []
      const podcastJson = { ...podcast.toOldJSONMinified(), metadata: podcast.oldMetadataToJSON() }
      for (const episode of localEpisodes) {
        if (episode.mediaProgresses?.some((progress) => progress.isFinished)) continue
        episodes.push({ ...episode.toOldJSONExpanded(item.id), libraryId: library.id, podcast: podcastJson, isDownloaded: true })
      }
      if (!podcast.feedURL) continue
      const feed = await getFeed(podcast.feedURL)
      if (!feed?.episodes) {
        failedFeeds.push(item.id)
        continue
      }
      const seen = new Set()
      for (const episode of feed.episodes) {
        if (!episode.enclosure?.url) continue
        // Match against finished downloads too, so they do not reappear as feed-only episodes.
        if (localEpisodes.some((local) => local.checkMatchesGuidOrEnclosureUrl(episode.guid, episode.enclosure.url))) continue
        const identity = episode.guid || episode.enclosure.url
        if (seen.has(identity)) continue
        seen.add(identity)
        const id = `feed-${item.id}-${createHash('sha256').update(identity).digest('hex')}`
        episodes.push({ ...episode, id, libraryItemId: item.id, libraryId: library.id, podcast: podcastJson, duration: episode.durationSeconds, isDownloaded: false, feedEpisode: episode })
      }
    }
  }))

  episodes.sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0) || a.id.localeCompare(b.id))
  return { episodes: limit ? episodes.slice(offset, offset + limit) : episodes.slice(offset), total: episodes.length, failedFeeds }
}
