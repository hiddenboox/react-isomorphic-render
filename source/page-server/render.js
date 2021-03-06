// produces wrong line numbers:
// import 'source-map-support/register'

import React from 'react'
import ReactDOM from 'react-dom/server'

// https://github.com/ReactTraining/react-router/issues/4023
// Also adds `useBasename` and `useQueries`
import createHistory from 'react-router/lib/createMemoryHistory'

import Html from './html'
import normalize_common_settings from '../redux/normalize'
import timer from '../timer'
import create_history from '../history'
import { location_url, parse_location } from '../location'

import redux_render, { initialize as redux_initialize } from '../redux/server/server'
import { render_on_server as react_router_render } from '../react-router/render'

import { Preload } from '../redux/actions'

// isomorphic (universal) rendering (middleware).
// will be used in web_application.use(...)
export default async function(settings, { initialize, localize, assets, application, request, render, loading, html = {}, authentication, cookies })
{
	settings = normalize_common_settings(settings)

	const
	{
		routes,
		wrapper
	}
	= settings

	const error_handler = settings.error

	// If Redux is being used, then render for Redux.
	// Else render for pure React.
	const render_page = redux_render

	// Read authentication token from a cookie (if configured)
	let authentication_token
	if (authentication && authentication.cookie)
	{
		authentication_token = cookies.get(authentication.cookie)
	}

	// `history` is created after the `store`.
	// At the same time, `store` needs the `history` later during navigation.
	// And `history` might need store for things like `react-router-redux`.
	// Hence the getter instead of a simple variable
	let history
	const get_history = () => history

	const initialize_timer = timer()

	// These `parameters` are used for `assets`, `html` modifiers
	// and also for `localize()` call.
	const initialize_result = await redux_initialize(settings,
	{
		authentication_token,
		application,
		request,
		initialize,
		get_history
	})
	
	const { extension_javascript, ...parameters } = initialize_result	

	// Create `history` (`true` indicates server-side usage).
	// Koa `request.url` is not really a URL,
	// it's a URL without the `origin` (scheme, host, port).
	history = create_history(createHistory, request.url, settings.history.options, parameters, true)

	const location = history.getCurrentLocation()
	const path     = location.pathname

	// The above code (server-side `initialize()` method call) is not included
	// in this `try/catch` block because:
	//
	//  * `parameters` are used inside `.error()`
	//
	//  * even if an error was caught inside `initialize()`
	//    and a redirection was performed, say, to an `/error` page
	//    then it would fail again because `initialize()` would get called again,
	//    so wrapping `initialize()` with `try/catch` wouldn't help anyway.
	//
	try
	{
		const initialize_time = initialize_timer()

		// Internationalization

		let locale
		let messages
		let messagesJSON

		if (localize)
		{
			const result = localize(parameters)

			locale   = result.locale
			messages = result.messages

			// A tiny optimization to avoid calculating
			// `JSON.stringify(messages)` for each rendered page.
			messagesJSON = result.messagesJSON || JSON.stringify(messages)
		}

		// Render the web page
		const result = await render_page
		({
			...parameters,
			disable_server_side_rendering: render === false,
			history,
			routes,

			create_page_element: (child_element, props) => 
			{
				if (localize)
				{
					props.locale   = locale
					props.messages = messages
				}

				return React.createElement(wrapper, props, child_element)
			},

			render_webpage(content)
			{
				// Render page content
				content = render === false ? normalize_markup(loading) : (content && ReactDOM.renderToString(content))

				// `html` modifiers

				let { head } = html
				// camelCase support for those who prefer it
				let body_start = html.body_start || html.bodyStart
				let body_end   = html.body_end   || html.bodyEnd

				// Normalize `html` parameters
				head       = normalize_markup(typeof head       === 'function' ? head      (path, parameters) : head)
				body_start = normalize_markup(typeof body_start === 'function' ? body_start(path, parameters) : body_start)
				body_end   = normalize_markup(typeof body_end   === 'function' ? body_end  (path, parameters) : body_end)

				// Normalize assets
				assets = typeof assets === 'function' ? assets(path, parameters) : assets

				// Sanity check
				if (!assets.entries)
				{
					throw new Error(`"assets.entries" array parameter is required as of version 10.1.0. E.g. "{ ... entries: ['main'] ... }"`)
				}

				// Render the HTML
				return Html
				({
					...parameters,
					extension_javascript: typeof extension_javascript === 'function' ? extension_javascript() : extension_javascript,
					assets,
					locale,
					locale_messages_json: messagesJSON,
					head,
					body_start,
					body_end,
					authentication_token,
					content
				})
			}
		})

		if (result.time)
		{
			result.time.initialize = initialize_time
		}

		return stringify_redirect(result, settings)
	}
	catch (error)
	{
		// Redirection is sometimes done via an Error on server side.
		// (e.g. it can happen in `react-router`'s `onEnter()` during `match()`)
		if (error._redirect)
		{
			return stringify_redirect({ redirect: error._redirect }, settings)
		}

		if (error_handler)
		{
			const result = {}

			const error_handler_parameters =
			{
				path,
				url      : location_url(location),
				redirect : to => result.redirect = parse_location(to),
				server   : true
			}

			// Special case for Redux
			if (parameters.store)
			{
				error_handler_parameters.dispatch = redirecting_dispatch(parameters.store.dispatch, error_handler_parameters.redirect)
				error_handler_parameters.getState = parameters.store.getState
			}

			error_handler(error, error_handler_parameters)
		
			// Either redirects or throws the error
			if (result.redirect)
			{
				return stringify_redirect(result, settings)
			}
		}

		throw error
	}
}

// Converts React.Elements to Strings
function normalize_markup(anything)
{
	if (!anything)
	{
		return ''
	}

	if (typeof anything === 'function')
	{
		return anything
	}

	if (typeof anything === 'string')
	{
		return anything
	}

	if (Array.isArray(anything))
	{
		return anything.map(normalize_markup).join('')
	}

	return ReactDOM.renderToString(anything)
}

// A special flavour of `dispatch` which `throw`s for redirects on the server side.
function redirecting_dispatch(dispatch, redirect)
{
	return (event) =>
	{
		switch (event.type)
		{
			// In case of navigation from @preload()
			case Preload:
				// `throw`s a special `Error` on server side
				return redirect(event.location)
		
			default:
				// Proceed with the original
				return dispatch(event)
		}
	}
}

function stringify_redirect(result, settings)
{
	if (result.redirect)
	{
		// Prepend `basename` to relative URLs for server-side redirect.
		result.redirect = location_url(result.redirect, { basename: settings.history.options.basename })
	}

	return result
}