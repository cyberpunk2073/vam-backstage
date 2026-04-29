import { Component } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('ErrorBoundary caught:', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="h-full flex items-center justify-center bg-base p-8">
          <div className="max-w-md text-center space-y-4">
            <AlertTriangle size={40} className="mx-auto text-warning opacity-60" />
            <h2 className="text-sm font-semibold text-text-primary">Something went wrong</h2>
            <p className="text-xs text-text-secondary leading-relaxed select-text cursor-text">
              {this.state.error.message || 'An unexpected error occurred.'}
            </p>
            <Button variant="gradient" onClick={() => this.setState({ error: null })}>
              <RefreshCw size={13} /> Try Again
            </Button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
