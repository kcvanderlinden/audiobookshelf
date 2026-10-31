const { expect } = require('chai')
const { Sequelize } = require('sequelize')
const sinon = require('sinon')
const Database = require('../../../server/Database')
const podcastUtils = require('../../../server/utils/podcastUtils')
const getRecentPodcastEpisodes = require('../../../server/utils/recentPodcastEpisodes')
const LibraryController = require('../../../server/controllers/LibraryController')

describe('Latest podcast feed episodes', () => {
  let library, folder, user, fetchFeed

  beforeEach(async () => {
    global.ServerSettings = {}
    Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    Database.sequelize.uppercaseFirst = (str) => str ? str[0].toUpperCase() + str.slice(1) : ''
    await Database.buildModels()
    library = await Database.libraryModel.create({ name: 'Podcasts', mediaType: 'podcast' })
    folder = await Database.libraryFolderModel.create({ path: '/podcasts', libraryId: library.id })
    user = await Database.userModel.create({ username: 'listener', type: 'root', permissions: Database.userModel.getDefaultPermissionsForUserType('root'), extraData: {} })
    fetchFeed = sinon.stub(podcastUtils, 'getPodcastFeed').resolves({ episodes: [] })
  })

  afterEach(async () => {
    sinon.restore()
    await Database.sequelize.close()
  })

  async function addPodcast(values = {}, libraryId = library.id) {
    const podcast = await Database.podcastModel.create({ title: 'Show', explicit: false, tags: [], genres: [], ...values })
    const item = await Database.libraryItemModel.create({ mediaId: podcast.id, mediaType: 'podcast', libraryId, libraryFolderId: folder.id, path: `/podcasts/${podcast.id}`, libraryFiles: [] })
    await podcast.update({ feedURL: `https://example.com/${podcast.id}/feed` })
    return { podcast, item }
  }

  function feedEpisode(guid, publishedAt) {
    return { guid, title: guid, publishedAt, durationSeconds: 60, enclosure: { url: `https://example.com/${guid}.mp3` } }
  }

  async function addDownload(podcast, episode) {
    return Database.podcastEpisodeModel.create({ podcastId: podcast.id, title: episode.title, publishedAt: episode.publishedAt, enclosureURL: episode.enclosure.url, extraData: { guid: episode.guid }, chapters: [], audioFile: { duration: 60, metadata: { filename: 'episode.mp3' } } })
  }

  it('merges subscriptions without downloads, sorts globally and paginates after merging', async () => {
    const first = await addPodcast()
    const second = await addPodcast()
    const local = await addDownload(first.podcast, feedEpisode('local', 1000))
    fetchFeed.withArgs(first.podcast.feedURL).resolves({ episodes: [feedEpisode('new', 3000), feedEpisode('local', 1000)] })
    fetchFeed.withArgs(second.podcast.feedURL).resolves({ episodes: [feedEpisode('other', 2000)] })
    const result = await getRecentPodcastEpisodes(user, library, 2, 0)
    expect(result.total).to.equal(3)
    expect(result.episodes.map((episode) => episode.title)).to.deep.equal(['new', 'other'])
    expect(result.episodes[0]).to.include({ isDownloaded: false, libraryItemId: first.item.id, duration: 60 })
    const page = await getRecentPodcastEpisodes(user, library, 2, 2)
    expect(page.episodes[0]).to.include({ id: local.id, isDownloaded: true })
    expect(fetchFeed.callCount).to.equal(2) // Feed cache shared across pages.
  })

  it('deduplicates by GUID and enclosure URL, including finished downloads', async () => {
    const { podcast } = await addPodcast()
    const local = await addDownload(podcast, feedEpisode('finished', 1000))
    await Database.mediaProgressModel.create({ userId: user.id, mediaItemId: local.id, mediaItemType: 'podcastEpisode', isFinished: true, podcastId: podcast.id })
    const duplicate = feedEpisode('new', 2000)
    fetchFeed.resolves({ episodes: [
      { ...feedEpisode('finished', 1000), enclosure: { url: 'https://changed.example/audio.mp3' } },
      { ...feedEpisode('changed-guid', 1000), enclosure: { url: local.enclosureURL } },
      duplicate, duplicate
    ] })
    const result = await getRecentPodcastEpisodes(user, library, 50, 0)
    expect(result.episodes.map((episode) => episode.title)).to.deep.equal(['new'])
    const repeat = await getRecentPodcastEpisodes(user, library, 50, 0)
    expect(repeat.episodes[0].id).to.equal(result.episodes[0].id)
  })

  it('keeps local episodes when a feed fails and reports only failed feed items', async () => {
    const { podcast, item } = await addPodcast()
    const local = await addDownload(podcast, feedEpisode('local', 1000))
    fetchFeed.rejects(new Error('Offline'))
    const result = await getRecentPodcastEpisodes(user, library, 50, 0)
    expect(result.episodes[0].id).to.equal(local.id)
    expect(result.failedFeeds).to.deep.equal([item.id])
  })

  it('does not fetch feeds outside the selected library or user content permissions', async () => {
    const allowed = await addPodcast({ tags: ['allowed'] })
    await addPodcast({ explicit: true, tags: ['allowed'] })
    await addPodcast({ tags: ['restricted'] })
    const otherLibrary = await Database.libraryModel.create({ name: 'Other', mediaType: 'podcast' })
    await addPodcast({ tags: ['allowed'] }, otherLibrary.id)
    const permissions = Database.userModel.getDefaultPermissionsForUserType('user')
    Object.assign(permissions, { accessExplicitContent: false, accessAllTags: false, itemTagsSelected: ['allowed'], selectedTagsNotAccessible: false })
    await user.update({ type: 'user', permissions })
    await getRecentPodcastEpisodes(user, library, 50, 0)
    expect(fetchFeed.callCount).to.equal(1)
    expect(fetchFeed.firstCall.args[0]).to.equal(allowed.podcast.feedURL)
  })

  it('does not return a new download as a feed-only episode even while the feed is cached', async () => {
    const { podcast } = await addPodcast()
    const episode = feedEpisode('new', 1000)
    fetchFeed.resolves({ episodes: [episode] })
    expect((await getRecentPodcastEpisodes(user, library, 50, 0)).episodes[0].isDownloaded).to.equal(false)
    const local = await addDownload(podcast, episode)
    const result = await getRecentPodcastEpisodes(user, library, 50, 0)
    expect(result.total).to.equal(1)
    expect(result.episodes[0]).to.include({ id: local.id, isDownloaded: true })
  })

  it('preserves local-only API behavior unless feed inclusion is requested', async () => {
    const { podcast } = await addPodcast()
    const local = await addDownload(podcast, feedEpisode('local', 1000))
    const res = { json: sinon.spy(), sendStatus: sinon.spy() }
    await LibraryController.getRecentEpisodes({ user, library, query: { limit: 50, page: 0 } }, res)
    expect(res.json.firstCall.args[0].episodes[0].id).to.equal(local.id)
    expect(fetchFeed.called).to.equal(false)
  })
})
