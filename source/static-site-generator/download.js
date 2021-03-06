import http from 'http'
import https from 'https'

// Downloads a URL resolving to its text contents
export default function download(url)
{
	return new Promise((resolve, reject) =>
	{
		const request = (url.indexOf('https://') === 0 ? https : http).request(url, (response) =>
		{
			response.setEncoding('utf8')

			let response_body = ''
			response.on('data', chunk => response_body += chunk)
			response.on('end', () => resolve(response_body))
		})

		request.on('error', reject)
		request.end()
	})
}