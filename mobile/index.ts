// Polyfills first: the protocol's crypto needs crypto.getRandomValues on Hermes.
import './src/polyfills';
import { registerRootComponent } from 'expo';
import App from './App';

registerRootComponent(App);
